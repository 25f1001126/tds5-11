const {
  hexId, hashOfObject, argumentsDigest, newTraceId, parseTraceparent,
  buildTraceparent, nowNanos, HttpError,
} = require('./util');
const { KIND, STATUS, addSpan, closeSpan, buildOtlp } = require('./otlp');
const planner = require('./planner');

const runs = new Map(); // runId -> run

function requireField(obj, path) {
  const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  if (v === undefined || v === null) throw new HttpError(422, `missing field: ${path}`);
  return v;
}

function dispatchJSON(action, attempt) {
  const a = action.attempts[attempt - 1];
  const base = {
    actionId: action.actionId,
    callId: action.callId,
    phase: action.phase,
    toolName: action.toolName,
    arguments: action.arguments,
    evidence: action.evidence,
    attempt,
    traceparent: a.traceparent,
  };
  if (a.approvalId) { base.approvalId = a.approvalId; base.approvalNonce = a.approvalNonce; }
  return base;
}

function createAction(run, { phase, toolName, arguments: args, evidence }) {
  const actionId = 'act_' + hexId(8);
  const callId = 'cal_' + hexId(8);
  const action = { actionId, callId, phase, toolName, arguments: args, evidence, attempts: [], terminal: false, finalStatus: null };
  run.actions[actionId] = action;
  run.actionOrder.push(actionId);
  return action;
}

function openAttempt(run, action, { approvalId, approvalNonce } = {}) {
  const attempt = action.attempts.length + 1;
  const clientSpan = addSpan(run, {
    role: `client:${action.actionId}:${attempt}`,
    parentSpanId: run.spanIndex[`exec:${action.actionId}`].spanId,
    name: `POST tool/${action.toolName}`,
    kind: KIND.CLIENT,
    attributes: {
      'ga5.action.id': action.actionId,
      'ga5.attempt': attempt,
      'http.request.method': 'POST',
      'http.request.resend_count': attempt - 1,
    },
  });
  const traceparent = buildTraceparent(run.traceId, clientSpan.spanId);
  action.attempts.push({
    attempt, spanId: clientSpan.spanId, traceparent, status: 'pending',
    approvalId, approvalNonce,
  });
  const d = dispatchJSON(action, attempt);
  run.actionLog.push(d);
  return d;
}

function ensureExecSpan(run, action) {
  if (!run.spanIndex[`exec:${action.actionId}`]) {
    addSpan(run, {
      role: `exec:${action.actionId}`,
      parentSpanId: run.spanIndex.agent.spanId,
      name: `execute_tool ${action.toolName}`,
      kind: KIND.INTERNAL,
      attributes: {
        'ga5.action.id': action.actionId,
        'gen_ai.tool.name': action.toolName,
        'gen_ai.tool.call.id': action.callId,
        'gen_ai.operation.name': 'execute_tool',
      },
    });
  }
}

function dispatchAction(run, action, opts) {
  ensureExecSpan(run, action);
  return openAttempt(run, action, opts);
}

async function createRun(body, headers) {
  if (body.profile !== 'ga5-incident-agent/v2') throw new HttpError(400, 'unsupported profile');
  const runId = requireField(body, 'runId');
  requireField(body, 'incident');
  requireField(body, 'toolCatalog');
  requireField(body, 'policy');

  const reqHash = hashOfObject(body);

  if (runs.has(runId)) {
    const existing = runs.get(runId);
    if (existing.requestHash === reqHash) return { status: 200, body: existing.initialResponse };
    throw new HttpError(409, 'runId exists with different content');
  }

  const incoming = parseTraceparent(headers['traceparent']);
  const traceId = incoming ? incoming.traceId : newTraceId();
  const incomingSpanId = incoming ? incoming.spanId : null;
  const tracestate = incoming ? headers['tracestate'] : undefined;

  const run = {
    runId,
    profile: body.profile,
    agentName: body.agentName || 'incident-response',
    publicMarker: body.publicMarker || '',
    policy: body.policy,
    toolCatalog: body.toolCatalog,
    requestHash: reqHash,
    traceId,
    tracestate,
    status: 'waiting',
    diagnosis: null,
    actions: {},
    actionOrder: [],
    actionLog: [],
    approvals: {},
    receiptLog: [],
    processedReceipts: {},
    chosenEffect: null,
    suppressed: [],
    spans: [],
    spanIndex: {},
    initialResponse: null,
    lastResponse: null,
    createdAt: nowNanos(),
  };
  runs.set(runId, run);

  // Root SERVER + INTERNAL agent spans
  addSpan(run, { role: 'server', parentSpanId: incomingSpanId, name: 'POST /v2/incidents', kind: KIND.SERVER });
  addSpan(run, { role: 'agent', parentSpanId: run.spanIndex.server.spanId, name: 'invoke_agent incident-response', kind: KIND.INTERNAL });

  // Model call — exactly one chat span per run
  const chatSpan = addSpan(run, {
    role: 'chat', parentSpanId: run.spanIndex.agent.spanId, name: 'chat incident-plan', kind: KIND.CLIENT,
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' },
  });

  let planResult;
  try {
    const { sensitive, ...safeBody } = body;
    planResult = await planner.plan({ incident: safeBody.incident, toolCatalog: safeBody.toolCatalog, policy: safeBody.policy });
    closeSpan(chatSpan, { code: STATUS.OK });
  } catch (e) {
    console.error('[engine] unexpected planner error, aborting to 500 for visibility:', e);
    throw new HttpError(500, `planning failed: ${e.message}`);
  }

  run.diagnosis = { rootCause: planResult.rootCause, evidence: planResult.evidence };

  const diagActions = planResult.diagnostics.map(d => createAction(run, {
    phase: 'diagnostic', toolName: d.toolName, arguments: d.arguments, evidence: d.evidence,
  }));

  const effectAction = createAction(run, {
    phase: 'effect', toolName: planResult.effect.toolName, arguments: planResult.effect.arguments, evidence: run.diagnosis.evidence.slice(0, 1),
  });
  run.effectActionId = effectAction.actionId;
  run.requiresApproval = (run.policy.approvalRequiredFor || []).includes(effectAction.toolName);

  const dispatches = diagActions.map(a => dispatchAction(run, a));

  if (diagActions.length > 1) {
    addSpan(run, {
      role: 'join', parentSpanId: run.spanIndex.agent.spanId, name: 'incident.join', kind: KIND.INTERNAL,
      links: diagActions.map(a => run.spanIndex[`exec:${a.actionId}`].spanId),
    });
    closeSpan(run.spanIndex.join, { code: STATUS.OK });
  }

  const response = { runId, status: 'waiting', diagnosis: run.diagnosis, dispatches, approvals: [] };
  run.initialResponse = response;
  run.lastResponse = response;
  return { status: 200, body: response };
}

function finalizeSpans(run, status) {
  for (const actionId of run.actionOrder) {
    const action = run.actions[actionId];
    const execRec = run.spanIndex[`exec:${actionId}`];
    if (execRec && !execRec.end) {
      closeSpan(execRec, { code: action.finalStatus === 'confirmed' ? STATUS.OK : (action.finalStatus === 'failed' ? STATUS.ERROR : STATUS.UNSET) });
    }
  }
  if (run.spanIndex.approval_gate && !run.spanIndex.approval_gate.end) closeSpan(run.spanIndex.approval_gate, { code: STATUS.OK });
  closeSpan(run.spanIndex.agent, { code: status === 'completed' ? STATUS.OK : STATUS.ERROR });
  closeSpan(run.spanIndex.server, { code: status === 'completed' ? STATUS.OK : STATUS.ERROR });
}

function snapshotFinal(run) {
  return {
    runId: run.runId,
    status: run.status,
    diagnosis: run.diagnosis,
    chosenEffect: run.chosenEffect,
    suppressed: run.suppressed,
    actionLog: run.actionLog,
    receiptLog: run.receiptLog,
    dispatches: [],
    approvals: [],
    otlp: buildOtlp(run),
  };
}

function applyOutcome(run, outcome, newDispatches) {
  const action = run.actions[outcome.actionId];
  if (!action || action.callId !== outcome.callId) throw new HttpError(422, 'unknown actionId/callId');
  const a = action.attempts[outcome.attempt - 1];
  if (!a || a.status !== 'pending') throw new HttpError(422, 'outcome for non-pending call');
  const clientSpan = run.spanIndex[`client:${action.actionId}:${outcome.attempt}`];

  a.receiptId = null; // set by caller with receiptId
  a.nonce = outcome.nonce;
  a.resultClass = outcome.resultClass;

  if (outcome.status === 200) {
    a.status = 'confirmed';
    action.finalStatus = 'confirmed';
    action.terminal = true;
    closeSpan(clientSpan, { code: STATUS.OK });
    clientSpan.attributes['http.response.status_code'] = 200;
    clientSpan.attributes['ga5.receipt.nonce'] = outcome.nonce;
  } else if (outcome.status === 503) {
    a.status = 'failed';
    closeSpan(clientSpan, { code: STATUS.ERROR, message: '503' });
    clientSpan.attributes['error.type'] = '503';
    clientSpan.attributes['http.response.status_code'] = 503;
    clientSpan.attributes['ga5.receipt.nonce'] = outcome.nonce;
    if (outcome.attempt === 1) {
      const d = dispatchAction(run, action); // opens attempt 2
      newDispatches.push(d);
    } else {
      action.finalStatus = 'failed';
      action.terminal = true;
    }
  } else if (outcome.status === 0 && outcome.errorType === 'timeout') {
    a.status = 'failed';
    action.finalStatus = 'failed';
    action.terminal = true;
    closeSpan(clientSpan, { code: STATUS.ERROR, message: 'timeout' });
    clientSpan.attributes['error.type'] = 'timeout';
    clientSpan.attributes['ga5.receipt.nonce'] = outcome.nonce;
  } else {
    a.status = 'failed';
    action.finalStatus = 'failed';
    action.terminal = true;
    closeSpan(clientSpan, { code: STATUS.ERROR, message: String(outcome.status) });
    clientSpan.attributes['error.type'] = String(outcome.errorType || outcome.status);
    clientSpan.attributes['ga5.receipt.nonce'] = outcome.nonce;
  }

  return {
    receiptId: undefined, actionId: action.actionId, callId: action.callId, attempt: outcome.attempt,
    status: outcome.status, resultClass: outcome.resultClass, nonce: outcome.nonce,
  };
}

function applyApprovalDecision(run, decision, newDispatches) {
  const approval = run.approvals[decision.approvalId];
  if (!approval || approval.status !== 'pending') throw new HttpError(422, 'unknown or resolved approvalId');

  if (decision.decision === 'approved') {
    approval.status = 'approved';
    approval.nonce = decision.nonce;
    closeSpan(run.spanIndex.approval_gate, { code: STATUS.OK });
    run.spanIndex.approval_gate.attributes['ga5.approval.id'] = approval.approvalId;
    run.spanIndex.approval_gate.attributes['ga5.approval.receipt.nonce'] = decision.nonce;

    const effectAction = run.actions[approval.actionId];
    const d = dispatchAction(run, effectAction, { approvalId: approval.approvalId, approvalNonce: decision.nonce });
    newDispatches.push(d);
  } else {
    approval.status = 'denied';
    closeSpan(run.spanIndex.approval_gate, { code: STATUS.ERROR, message: 'denied' });
    const effectAction = run.actions[approval.actionId];
    effectAction.finalStatus = 'suppressed';
    effectAction.terminal = true;
    run.suppressed.push({ actionId: effectAction.actionId, toolName: effectAction.toolName, reason: 'approval_denied' });
  }

  return { approvalId: approval.approvalId, decision: decision.decision, nonce: decision.nonce };
}

function advance(run, newDispatches, newApprovalRequests) {
  const diagActions = run.actionOrder.filter(id => run.actions[id].phase === 'diagnostic').map(id => run.actions[id]);
  const effectAction = run.actions[run.effectActionId];

  const allDiagTerminal = diagActions.every(a => a.terminal);
  if (!allDiagTerminal) return; // still waiting on diagnostics

  const anyDiagFailed = diagActions.some(a => a.finalStatus === 'failed');

  if (anyDiagFailed) {
    if (effectAction.finalStatus == null) {
      effectAction.finalStatus = 'suppressed';
      effectAction.terminal = true;
      run.suppressed.push({ actionId: effectAction.actionId, toolName: effectAction.toolName, reason: 'diagnostic_failed' });
    }
    if (run.status === 'waiting') {
      finalizeSpans(run, 'completed');
      run.status = 'completed';
      run.chosenEffect = null;
    }
    return;
  }

  if (effectAction.finalStatus === 'confirmed') {
    if (run.status === 'waiting') {
      finalizeSpans(run, 'completed');
      run.status = 'completed';
      run.chosenEffect = effectAction.toolName;
    }
    return;
  }
  if (effectAction.finalStatus === 'failed') {
    if (run.status === 'waiting') {
      finalizeSpans(run, 'failed');
      run.status = 'failed';
      run.chosenEffect = null;
    }
    return;
  }
  if (effectAction.finalStatus === 'suppressed') return; // already finalized above

  if (effectAction.attempts.length === 0 && !run.approvals[Object.keys(run.approvals).find(k => run.approvals[k].actionId === effectAction.actionId)]) {
    if (run.requiresApproval) {
      const approvalId = 'apr_' + hexId(8);
      const digest = argumentsDigest(effectAction.arguments);
      run.approvals[approvalId] = { approvalId, actionId: effectAction.actionId, toolName: effectAction.toolName, argumentsDigest: digest, status: 'pending' };
      addSpan(run, { role: 'approval_gate', parentSpanId: run.spanIndex.agent.spanId, name: 'approval_gate', kind: KIND.INTERNAL,
        attributes: { 'ga5.approval.id': approvalId } });
      newApprovalRequests.push({ approvalId, actionId: effectAction.actionId, toolName: effectAction.toolName, argumentsDigest: digest });
    } else {
      const d = dispatchAction(run, effectAction);
      newDispatches.push(d);
    }
  }
}

async function processReceipts(runId, body, headers) {
  const run = runs.get(runId);
  if (!run) throw new HttpError(404, 'unknown runId');

  const receiptId = requireField(body, 'receiptId');
  const reqHash = hashOfObject(body);

  if (run.processedReceipts[receiptId]) {
    const prev = run.processedReceipts[receiptId];
    if (prev.hash === reqHash) return { status: 200, body: prev.response };
    throw new HttpError(409, 'receiptId exists with different content');
  }

  if (run.status !== 'waiting') throw new HttpError(422, 'run already terminal; no new receipts accepted');

  const hasOutcomes = Array.isArray(body.outcomes);
  const hasApprovals = Array.isArray(body.approvals);
  if (!hasOutcomes && !hasApprovals) throw new HttpError(422, 'receipt must contain outcomes or approvals');

  const newDispatches = [];
  const newApprovalRequests = [];

  if (hasOutcomes) {
    for (const outcome of body.outcomes) {
      const logged = applyOutcome(run, outcome, newDispatches);
      logged.receiptId = receiptId;
      run.receiptLog.push(logged);
    }
  }
  if (hasApprovals) {
    for (const decision of body.approvals) {
      const logged = applyApprovalDecision(run, decision, newDispatches);
      run.receiptLog.push({ receiptId, ...logged });
    }
  }

  advance(run, newDispatches, newApprovalRequests);

  const response = run.status !== 'waiting'
    ? snapshotFinal(run)
    : { runId: run.runId, status: 'waiting', dispatches: newDispatches, approvals: newApprovalRequests };

  run.processedReceipts[receiptId] = { hash: reqHash, response };
  run.lastResponse = response;
  return { status: 200, body: response };
}

function getRun(runId) {
  const run = runs.get(runId);
  if (!run) throw new HttpError(404, 'unknown runId');
  return { status: 200, body: run.lastResponse };
}

module.exports = { createRun, processReceipts, getRun };
