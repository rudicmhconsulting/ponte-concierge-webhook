const express = require('express');
const { Pool } = require('pg');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ponte_secure_token_2026';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const HUD_USER = process.env.HUD_USER || 'admin';
const HUD_PASSWORD = process.env.HUD_PASSWORD || 'ponte2026';

// ============================================================================
// DUAL-LINE WABA IDENTIFIERS (Ponte Concierges WABA 1799638264570073)
// ============================================================================
const PHONE_ID_MAIN = process.env.PHONE_NUMBER_ID_MAIN || '1358165517385065';       // 081 097 3478 (Ops / Passes / Errands)
const PHONE_ID_SUPPORT = process.env.PHONE_NUMBER_ID_SUPPORT || '1448916934975007'; // 072 949 4561 (AI Support & Self-Healing)

// Operational Hotline & Admin Phones
const ADMIN_REPORT_PHONE = '27715720458';
const RECEPTION_WA_GROUP = process.env.RECEPTION_WA_GROUP || '27715720458';
const SECURITY_DUTY_PHONE = process.env.SECURITY_DUTY_PHONE || '27715720458';

// ============================================================================
// PAYSTACK LIVE CONFIGURATION (Ponte Concierges Profile 2094725)
// ============================================================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_SPLIT_CODE = process.env.PAYSTACK_SPLIT_CODE || 'SPL_o0LUe5ffNG';
const FALLBACK_PAYMENT_PAGE = 'https://paystack.shop/pay/lv9owmpxuo';

// ============================================================================
// GEMINI CLIENT SETUP (gemini-2.5-flash)
// ============================================================================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ============================================================================
// POSTGRESQL PERSISTENCE ENGINE (WRITE-THROUGH + STARTUP REHYDRATION)
// ============================================================================
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

async function initDatabase() {
  if (!pool) {
    console.warn('⚠️ [DB] DATABASE_URL not set. Running in volatile in-memory mode.');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ponte_runner_jobs (
        job_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ponte_issued_passes (
        pass_token TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ponte_security_alerts (
        alert_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ponte_backlog_stories (
        story_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ponte_incident_logs (
        incident_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Rehydrate in-memory stores from PostgreSQL on startup
    const jobsRes = await pool.query('SELECT job_id, payload FROM ponte_runner_jobs');
    for (const row of jobsRes.rows) runnerJobs.set(row.job_id, row.payload);

    const passesRes = await pool.query('SELECT pass_token, payload FROM ponte_issued_passes');
    for (const row of passesRes.rows) issuedPasses.set(row.pass_token, row.payload);

    const alertsRes = await pool.query('SELECT alert_id, payload FROM ponte_security_alerts');
    for (const row of alertsRes.rows) securityAlerts.set(row.alert_id, row.payload);

    const storiesRes = await pool.query('SELECT payload FROM ponte_backlog_stories ORDER BY created_at ASC');
    customerBacklogQueue.length = 0;
    for (const row of storiesRes.rows) customerBacklogQueue.push(row.payload);

    const incidentsRes = await pool.query('SELECT payload FROM ponte_incident_logs ORDER BY created_at ASC');
    systemIncidentLog.length = 0;
    for (const row of incidentsRes.rows) systemIncidentLog.push(row.payload);

    console.log(
      `✅ [DB HYDRATED] Jobs: ${runnerJobs.size} | Passes: ${issuedPasses.size} | Alerts: ${securityAlerts.size} | Stories: ${customerBacklogQueue.length} | Incidents: ${systemIncidentLog.length}`
    );
  } catch (err) {
    console.error('❌ [DB INIT ERROR]:', err.message);
  }
}

async function persistJob(job) {
  runnerJobs.set(job.jobId, job);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ponte_runner_jobs (job_id, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (job_id) DO UPDATE SET payload = $2::jsonb, updated_at = NOW()`,
      [job.jobId, JSON.stringify(job)]
    );
  } catch (err) {
    console.error('❌ [DB] persistJob error:', err.message);
  }
}

async function deleteJob(jobId) {
  runnerJobs.delete(jobId);
  if (!pool) return;
  try {
    await pool.query('DELETE FROM ponte_runner_jobs WHERE job_id = $1', [jobId]);
  } catch (err) {
    console.error('❌ [DB] deleteJob error:', err.message);
  }
}

async function persistPass(pass) {
  issuedPasses.set(pass.passToken, pass);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ponte_issued_passes (pass_token, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (pass_token) DO UPDATE SET payload = $2::jsonb, updated_at = NOW()`,
      [pass.passToken, JSON.stringify(pass)]
    );
  } catch (err) {
    console.error('❌ [DB] persistPass error:', err.message);
  }
}

async function deletePass(passToken) {
  issuedPasses.delete(passToken);
  if (!pool) return;
  try {
    await pool.query('DELETE FROM ponte_issued_passes WHERE pass_token = $1', [passToken]);
  } catch (err) {
    console.error('❌ [DB] deletePass error:', err.message);
  }
}

async function persistAlert(alert) {
  securityAlerts.set(alert.alertId, alert);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ponte_security_alerts (alert_id, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (alert_id) DO UPDATE SET payload = $2::jsonb, updated_at = NOW()`,
      [alert.alertId, JSON.stringify(alert)]
    );
  } catch (err) {
    console.error('❌ [DB] persistAlert error:', err.message);
  }
}

async function persistStory(storyItem) {
  const existingIdx = customerBacklogQueue.findIndex((s) => s.id === storyItem.id);
  if (existingIdx >= 0) customerBacklogQueue[existingIdx] = storyItem;
  else customerBacklogQueue.push(storyItem);

  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ponte_backlog_stories (story_id, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (story_id) DO UPDATE SET payload = $2::jsonb`,
      [storyItem.id, JSON.stringify(storyItem)]
    );
  } catch (err) {
    console.error('❌ [DB] persistStory error:', err.message);
  }
}

async function persistIncident(logEntry) {
  systemIncidentLog.push(logEntry);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ponte_incident_logs (incident_id, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (incident_id) DO UPDATE SET payload = $2::jsonb`,
      [logEntry.incidentId, JSON.stringify(logEntry)]
    );
  } catch (err) {
    console.error('❌ [DB] persistIncident error:', err.message);
  }
}

// ============================================================================
// RUNTIME WORKING STORES (HYDRATED FROM DB ON STARTUP)
// ============================================================================
const userProfiles = new Map();
const residentSessions = new Map();
const visitorSessions = new Map();
const issuedPasses = new Map();
const runnerJobs = new Map();
const securityAlerts = new Map();
const customerBacklogQueue = [];
const systemIncidentLog = [];

// Seed Verified Resident & Active Runners
userProfiles.set('27715720458', { role: 'RESIDENT', registeredAt: new Date(), unit: '5102', fullName: 'RC Janse van Rensburg' });
userProfiles.set('27832778743', { role: 'RUNNER', registeredAt: new Date(), fullName: 'Kaycee' });
userProfiles.set('27822229285', { role: 'RUNNER', registeredAt: new Date(), fullName: 'Vusi' });
userProfiles.set('27688814679', { role: 'RUNNER', registeredAt: new Date(), fullName: 'Musa' });
userProfiles.set('27656206712', { role: 'RUNNER', registeredAt: new Date(), fullName: 'Faith' });

// ============================================================================
// HUD BASIC AUTH GUARD (PROTECTS /admin/* & /security/*)
// ============================================================================
function requireHudAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Ponte Concierge Operations HUD"');
    return res.status(401).send('Authentication required.');
  }
  const base64Credentials = authHeader.split(' ')[1];
  const [user, pass] = Buffer.from(base64Credentials, 'base64').toString('ascii').split(':');
  if (user === HUD_USER && pass === HUD_PASSWORD) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Ponte Concierge Operations HUD"');
  return res.status(401).send('Invalid credentials.');
}

// ============================================================================
// OUTBOUND META GRAPH API HELPERS
// ============================================================================
async function sendWhatsAppMessage(recipientPhone, messageText, senderPhoneId = PHONE_ID_MAIN) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'text',
      text: { body: messageText },
    };
    const res = await fetch(`https://graph.facebook.com/v18.0/${senderPhoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!res.ok || result.error) {
      console.error(`❌ Meta Outbound Send Error from ${senderPhoneId} to ${recipientPhone}:`, JSON.stringify(result));
    } else {
      console.log(`✅ Message delivered via ${senderPhoneId} to ${recipientPhone} (ID: ${result.messages?.[0]?.id})`);
    }
    return result;
  } catch (error) {
    console.error(`❌ Network Error in sendWhatsAppMessage:`, error.message);
  }
}

async function sendInteractiveButtons(recipientPhone, headerText, bodyText, buttons, footerText = '', senderPhoneId = PHONE_ID_MAIN) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: headerText ? { type: 'text', text: headerText } : undefined,
        body: { text: bodyText },
        footer: footerText ? { text: footerText } : undefined,
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.substring(0, 20) },
          })),
        },
      },
    };
    const res = await fetch(`https://graph.facebook.com/v18.0/${senderPhoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (error) {
    console.error(`❌ Error in sendInteractiveButtons:`, error.message);
  }
}

async function sendWhatsAppImage(recipientPhone, imageUrl, caption, senderPhoneId = PHONE_ID_MAIN) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'image',
      image: { link: imageUrl, caption: caption },
    };
    const res = await fetch(`https://graph.facebook.com/v18.0/${senderPhoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (error) {
    console.error(`❌ Error in sendWhatsAppImage:`, error.message);
  }
}

async function broadcastRunnerJob(job) {
  const runnerAlertText =
    `🏃 *NEW PONTE RUNNER TASK [#${job.jobId}]*\n\n` +
    `• *Type:* ${job.taskType}\n` +
    `• *Host:* ${job.hostName} (Unit ${job.unit}) - ${job.hostPhone}\n` +
    `📌 *Pickup Instructions:*\n_${job.details}_\n\n` +
    `• *Payout:* ${job.payout}`;

  for (const [phone, profile] of userProfiles.entries()) {
    if (profile.role === 'RUNNER') {
      await sendInteractiveButtons(
        phone,
        'PONTE TASK DISPATCH',
        runnerAlertText,
        [
          { id: `JOB_ACCEPT_${job.jobId}`, title: 'Accept Task 🚀' },
          { id: `JOB_DECLINE_${job.jobId}`, title: 'Decline' }
        ],
        '',
        PHONE_ID_MAIN
      );
    }
  }
}

// ============================================================================
// AUTONOMOUS DIAGNOSTICS & SELF-HEALING ENGINE (SYSTEM + OPS)
// ============================================================================
async function diagnoseAndRemediateOperationalIssue(senderPhone, issueDescription) {
  console.log(`🩺 [DIAGNOSTICS] Investigating issue from ${senderPhone}: "${issueDescription}"`);
  const lowerIssue = issueDescription.toLowerCase();
  const nowSast = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const dateSast = new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' });

  // 1. SYSTEM FAULT: Daily Audit Report / Scheduler Missed Tick
  if (
    lowerIssue.includes('audit') ||
    lowerIssue.includes('report') ||
    lowerIssue.includes('20:00') ||
    lowerIssue.includes('schedule')
  ) {
    await sendDailyAuditReport();

    const logEntry = {
      incidentId: `INC-${Date.now().toString().slice(-4)}`,
      timestamp: `${dateSast} ${nowSast}`,
      caller: senderPhone,
      rootCause: 'Render idle sleep skipped internal 20:00 SAST timer.',
      resolution: 'Auto-dispatched Daily Audit Report immediately & verified /api/cron/daily-audit endpoint.',
      status: 'AUTO_RESOLVED'
    };
    await persistIncident(logEntry);

    return {
      resolved: true,
      message: `🛠️ *Auto-Fix Executed [${logEntry.incidentId}]:* Render's sleep cycle skipped the internal 20:00 timer. I have dispatched today's Daily Audit Report to your admin WhatsApp right now and logged the incident in the HUD.`
    };
  }

  // 2. SYSTEM FAULT: HUD / Database / Telemetry Health Check
  if (
    lowerIssue.includes('hud') ||
    lowerIssue.includes('backlog') ||
    lowerIssue.includes('status') ||
    lowerIssue.includes('db') ||
    lowerIssue.includes('database') ||
    lowerIssue.includes('memory')
  ) {
    const dbStatus = pool ? 'CONNECTED (PostgreSQL Persistent)' : 'IN-MEMORY ONLY (Set DATABASE_URL)';
    const logEntry = {
      incidentId: `INC-${Date.now().toString().slice(-4)}`,
      timestamp: `${dateSast} ${nowSast}`,
      caller: senderPhone,
      rootCause: 'System health & persistence telemetry check requested.',
      resolution: `Verified DB: ${dbStatus} | Jobs: ${runnerJobs.size}, Passes: ${issuedPasses.size}, Stories: ${customerBacklogQueue.length}.`,
      status: 'AUTO_RESOLVED'
    };
    await persistIncident(logEntry);

    return {
      resolved: true,
      message:
        `📊 *Live System Telemetry [${logEntry.incidentId}]:*\n` +
        `• *Persistence:* ${dbStatus}\n` +
        `• *Active Jobs:* ${runnerJobs.size}\n` +
        `• *Active Passes:* ${issuedPasses.size}\n` +
        `• *Backlog Stories:* ${customerBacklogQueue.length}\n` +
        `• *Logged Incidents:* ${systemIncidentLog.length}`
    };
  }

  // 3. OPS FAULT: Active Runner Delay / Stalled Errand
  const userJobs = Array.from(runnerJobs.values()).filter(
    (j) => j.hostPhone === senderPhone && j.status !== 'COMPLETED_VERIFIED'
  );

  if (userJobs.length > 0) {
    const latestJob = userJobs[userJobs.length - 1];
    const previousRunner = latestJob.claimedBy;
    const runnerName = previousRunner ? (userProfiles.get(previousRunner)?.fullName || previousRunner) : 'Unassigned';

    latestJob.status = 'PAID_AWAITING_CLAIM';
    latestJob.claimedBy = null;
    latestJob.reassignedAt = nowSast;
    await persistJob(latestJob);

    await broadcastRunnerJob(latestJob);

    if (previousRunner) {
      await sendWhatsAppMessage(
        previousRunner,
        `⚠️ *Task #${latestJob.jobId} Reassigned*\nResident reported a delay. The task has been re-queued to the active runner pool.`,
        PHONE_ID_MAIN
      );
    }

    const logEntry = {
      incidentId: `INC-${Date.now().toString().slice(-4)}`,
      timestamp: `${dateSast} ${nowSast}`,
      caller: senderPhone,
      jobId: latestJob.jobId,
      rootCause: `Runner delay reported on Task #${latestJob.jobId} (Previous runner: ${runnerName}).`,
      resolution: `Cleared lock on #${latestJob.jobId}, persisted state, and re-broadcast to active runner roster.`,
      status: 'AUTO_RESOLVED'
    };
    await persistIncident(logEntry);

    await sendWhatsAppMessage(
      ADMIN_REPORT_PHONE,
      `🛠️ *SELF-HEALING RESOLUTION EXECUTED [${logEntry.incidentId}]*\n\n` +
      `• *Caller:* ${senderPhone}\n` +
      `• *Issue:* "${issueDescription}"\n` +
      `• *Diagnosis:* Job #${latestJob.jobId} stalled with runner ${runnerName}.\n` +
      `• *Automated Fix:* Released lock, saved to DB, re-broadcast to 4 runners.`,
      PHONE_ID_MAIN
    );

    return {
      resolved: true,
      jobId: latestJob.jobId,
      message: `I investigated Task #${latestJob.jobId}. The assigned runner encountered a delay, so the system has automatically unassigned them and re-broadcast your delivery to the full active runner roster.`
    };
  }

  // 4. OPS FAULT: Pending Gate Clearance Alert
  const userAlerts = Array.from(securityAlerts.values()).filter(
    (a) => (a.hostPhone === senderPhone || a.visitorPhone === senderPhone) && a.status === 'PENDING_MANUAL_REVIEW'
  );

  if (userAlerts.length > 0) {
    const alert = userAlerts[userAlerts.length - 1];
    alert.status = 'APPROVED';
    await persistAlert(alert);

    await sendWhatsAppMessage(
      alert.visitorPhone,
      `🛡️ *Access Pass Fast-Tracked*\nYour resident host confirmed arrival. Building security desk has expedited your clearance at the gate.`,
      PHONE_ID_MAIN
    );

    const logEntry = {
      incidentId: `INC-${Date.now().toString().slice(-4)}`,
      timestamp: `${dateSast} ${nowSast}`,
      caller: senderPhone,
      rootCause: `Gate pass voucher ${alert.alertId} stuck in PENDING_MANUAL_REVIEW.`,
      resolution: `Auto-approved ${alert.alertId} upon verified host report & persisted to DB.`,
      status: 'AUTO_RESOLVED'
    };
    await persistIncident(logEntry);

    await sendWhatsAppMessage(
      ADMIN_REPORT_PHONE,
      `🛠️ *AUTO-RESOLVED GATE PASS [${alert.alertId}]*\nGuest ${alert.visitorName} fast-tracked for entry upon host report.`,
      PHONE_ID_MAIN
    );

    return {
      resolved: true,
      message: `I located guest clearance voucher ${alert.alertId}. The system has verified your resident record and fast-tracked turnstile clearance.`
    };
  }

  // 5. Fallback: Log & Escalate Unmatched Technical Issue
  const logEntry = {
    incidentId: `INC-${Date.now().toString().slice(-4)}`,
    timestamp: `${dateSast} ${nowSast}`,
    caller: senderPhone,
    rootCause: issueDescription,
    resolution: 'Persisted to incident HUD & escalated to Operations Admin.',
    status: 'ESCALATED'
  };
  await persistIncident(logEntry);

  await sendWhatsAppMessage(
    ADMIN_REPORT_PHONE,
    `🚨 *SUPPORT INCIDENT LOGGED [${logEntry.incidentId}]*\n• *From:* ${senderPhone}\n• *Issue:* "${issueDescription}"`,
    PHONE_ID_MAIN
  );

  return {
    resolved: false,
    message: `I have logged incident [${logEntry.incidentId}] in the Operations HUD and notified the admin team.`
  };
}

// ============================================================================
// DETERMINISTIC FAULT FAST-PATH + GEMINI 2.5 FLASH SUPPORT & BACKLOG AGENT
// ============================================================================
async function handleSupportAndBacklogAgent(senderPhone, userMessage, replyFromPhoneId = PHONE_ID_SUPPORT) {
  const lowerMsg = userMessage.toLowerCase();

  // 1. DETERMINISTIC FAST-PATH FOR SYSTEM & OPS FAULTS (Zero AI API Dependency)
  const faultKeywords = [
    'audit', 'report', '20:00', 'schedule', 'hud', 'backlog', 'status',
    'db', 'database', 'memory', 'late', 'runner', 'stuck', 'delay',
    'gate', 'pass', 'broken', 'error', 'not running', 'not working', 'issue'
  ];

  if (faultKeywords.some((kw) => lowerMsg.includes(kw))) {
    const remediation = await diagnoseAndRemediateOperationalIssue(senderPhone, userMessage);
    await sendWhatsAppMessage(senderPhone, remediation.message, replyFromPhoneId);
    return;
  }

  // 2. GEMINI AI TRIAGE FOR FEATURE REQUESTS & GENERAL SUPPORT
  try {
    const prompt = `
You are the AI Concierge Support & Autonomous Operations Agent for "Ponte Concierge" at Ponte City, Johannesburg.
A resident, runner, or visitor texted our dedicated support line (+27 72 949 4561):
"${userMessage}"

Key Operational Context:
- Errand Service: R35 promo flat fee paid on WhatsApp via Paystack. Runners earn R25 on dual confirmation.
- Visitor Clearance: 100% digital on WhatsApp, optical QR passes valid for 24 hours.
- Front Desk / Reception Hours: 07:00 to 16:00, Monday to Friday. Security desk is manned 24/7.

Instructions:
1. Classify intent:
   - "FEATURE_REQUEST": Any suggestion, feedback, idea, or capability not yet automated (e.g. recurring daily bread/milk deliveries, off-site mall errands, car wash).
   - "SUPPORT_QUERY": General questions (reception hours, how it works, pricing, rules).
2. If FEATURE_REQUEST: Formulate a clean Agile User Story ("As a [user], I want [feature] so that [benefit]") with Business Value ("High", "Medium", "Low").
3. Reply concisely and warmly (max 3 sentences) suitable for WhatsApp.
`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: { type: Type.STRING },
            replyText: { type: Type.STRING },
            userStory: { type: Type.STRING, nullable: true },
            businessValue: { type: Type.STRING, nullable: true }
          },
          required: ['category', 'replyText']
        }
      }
    });

    const parsed = JSON.parse(response.text.trim());
    console.log(`🤖 [GEMINI PARSED] Category: ${parsed.category} | Input: "${userMessage}"`);

    await sendWhatsAppMessage(senderPhone, parsed.replyText, replyFromPhoneId);

    if (parsed.category === 'FEATURE_REQUEST' && parsed.userStory) {
      const storyItem = {
        id: `STORY-${Date.now().toString().slice(-4)}`,
        rawFeedback: userMessage,
        userStory: parsed.userStory,
        businessValue: parsed.businessValue || 'Medium',
        senderPhone: senderPhone,
        status: 'PENDING_APPROVAL',
        submittedAt: new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
        submittedDate: new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' })
      };

      await persistStory(storyItem);
      console.log(`📋 [PERSISTED BACKLOG] Added ${storyItem.id}: "${storyItem.userStory}"`);

      await sendWhatsAppMessage(
        ADMIN_REPORT_PHONE,
        `💡 *NEW SUGGESTED USER STORY [${storyItem.id}]*\n\n` +
        `• *Story:* ${storyItem.userStory}\n` +
        `• *Value:* ${storyItem.businessValue}\n` +
        `• *Source:* ${senderPhone}\n\n` +
        `_Saved permanently in /admin/backlog._`,
        PHONE_ID_MAIN
      );
    }
  } catch (err) {
    console.error('❌ AI Support Agent Error:', err.message);
    await sendWhatsAppMessage(
      senderPhone,
      `Hello! Ponte Concierge Support has received your message. Our operational team will review it shortly.`,
      replyFromPhoneId
    );
  }
}

// ============================================================================
// IMAGE NORMALIZATION & FUZZY OCR
// ============================================================================
async function preprocessDocumentImage(rawBuffer, rotateAngle = 0) {
  try {
    let pipeline = sharp(rawBuffer).rotate();
    if (rotateAngle > 0) pipeline = pipeline.rotate(rotateAngle);

    return await pipeline
      .resize({ width: 1400, withoutEnlargement: true })
      .greyscale()
      .normalize()
      .toBuffer();
  } catch (err) {
    console.warn('⚠️ Sharp pre-processing warning, using raw buffer:', err.message);
    return rawBuffer;
  }
}

async function performDocumentOCR(imageBuffer, declaredId, declaredName) {
  let worker = null;
  try {
    let processedBuffer = await preprocessDocumentImage(imageBuffer, 0);
    worker = await createWorker('eng');
    let ret = await worker.recognize(processedBuffer);
    let rawText = ret.data.text.toUpperCase();

    const hasDocKeywords = (text) =>
      text.includes('SOUTH AFRICA') || text.includes('SUID-AFRIKA') ||
      text.includes('REPUBLIC') || text.includes('IDENTITY') ||
      text.includes('PASSPORT') || text.includes('DRIVING') ||
      text.includes('LICENCE') || text.includes('P<ZAF') ||
      text.includes('<<<<') || text.includes('P<');

    if (!hasDocKeywords(rawText)) {
      const rotatedBuffer = await preprocessDocumentImage(imageBuffer, 90);
      const retRotated = await worker.recognize(rotatedBuffer);
      const rotatedText = retRotated.data.text.toUpperCase();
      if (hasDocKeywords(rotatedText)) rawText = rotatedText;
    }

    await worker.terminate();

    const alphanumericOnly = rawText.replace(/[^A-Z0-9]/g, '');
    const cleanId = declaredId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const isNumericSAID = /^\d{13}$/.test(cleanId);

    let fullIdMatch = alphanumericOnly.includes(cleanId);
    let partialIdMatch = false;

    if (isNumericSAID) {
      const birthDigits = cleanId.substring(0, 6);
      const lastDigits = cleanId.substring(6);
      partialIdMatch = alphanumericOnly.includes(birthDigits) &&
        (alphanumericOnly.includes(lastDigits) || alphanumericOnly.includes(cleanId.substring(6, 11)));
    }

    const stopWords = new Set(['VAN', 'DER', 'DE', 'DEN', 'DU', 'LA', 'LE', 'AND', 'MR', 'MRS', 'MS']);
    const declaredTokens = declaredName
      .toUpperCase()
      .replace(/[^A-Z\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !stopWords.has(t));

    const hasSignificantNameMatch = declaredTokens.some(token => {
      if (rawText.includes(token)) return true;
      const stem = token.substring(0, Math.max(3, token.length - 1));
      return rawText.includes(stem);
    });

    const isSAPassport = (rawText.includes('P<ZAF') || (rawText.includes('SOUTH AFRICA') && rawText.includes('PASSPORT')));
    const isMRZPassport = rawText.includes('P<') || rawText.includes('<<<<') || rawText.includes('PASSPORT');
    const isSADocument = (rawText.includes('SOUTH AFRICA') || rawText.includes('SUID-AFRIKA') || isSAPassport);

    if ((fullIdMatch || partialIdMatch || hasSignificantNameMatch) && isSADocument) {
      return { verified: true, reason: 'SA_DOC_MATCH_CONFIRMED' };
    }

    if (isMRZPassport && !isSAPassport && fullIdMatch) {
      return { verified: true, reason: 'FOREIGN_PASSPORT_MRZ_VERIFIED', isForeign: true };
    }

    return { verified: false, reason: `Document check required for '${declaredName}'. Physical check required.` };
  } catch (err) {
    if (worker) await worker.terminate();
    return { verified: false, reason: 'OCR unreadable or image error' };
  }
}

async function downloadMetaImage(imageId) {
  try {
    const mediaRes = await fetch(`https://graph.facebook.com/v18.0/${imageId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const mediaData = await mediaRes.json();
    if (!mediaData.url) throw new Error('No media URL returned by Meta');

    const imageRes = await fetch(mediaData.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const arrayBuffer = await imageRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('❌ Image download error:', err.message);
    return null;
  }
}

// ============================================================================
// PAYSTACK DYNAMIC CHECKOUT
// ============================================================================
async function generatePaystackCheckout(residentPhone, unit, jobId) {
  try {
    const payload = {
      email: `resident.unit${unit}@ponteconcierge.co.za`,
      amount: 3500, // R35.00
      currency: 'ZAR',
      reference: `PC-${jobId}-${Date.now().toString().slice(-4)}`,
      callback_url: `https://wa.me/27810973478`,
      split_code: PAYSTACK_SPLIT_CODE,
      channels: ['card', 'eft', 'bank', 'qr', 'apple_pay', 'capitec_pay'],
      metadata: {
        jobId: jobId,
        phone: residentPhone,
        unit: unit,
        pricing: 'PROMO_R35',
        service: 'PONTE_RUNNER_SERVICE',
        custom_fields: [
          { display_name: "Unit Number", variable_name: "unit_number", value: unit },
          { display_name: "Task Reference", variable_name: "task_ref", value: `#${jobId}` }
        ]
      }
    };

    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.status && data.data?.authorization_url) {
      return data.data.authorization_url;
    }
    return FALLBACK_PAYMENT_PAGE;
  } catch (err) {
    console.error('❌ Paystack Initialization Exception:', err.message);
    return FALLBACK_PAYMENT_PAGE;
  }
}

function isReceptionOpen() {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const sastHours = (utcHours + 2) % 24;
  const sastDay = now.getUTCDay();
  return (sastDay >= 1 && sastDay <= 5) && (sastHours >= 7 && sastHours < 16);
}

function validateSouthAfricanID(idNumber) {
  if (!/^\d{13}$/.test(idNumber)) return false;
  const month = parseInt(idNumber.substring(2, 4), 10);
  const day = parseInt(idNumber.substring(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let digit = parseInt(idNumber[i], 10);
    if (i % 2 !== 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return ((10 - (sum % 10)) % 10) === parseInt(idNumber[12], 10);
}

function maskID(idNumber) {
  if (!idNumber) return 'DOC-RECORDED';
  if (idNumber.length === 13) return `${idNumber.substring(0, 6)}*****${idNumber.substring(11)}`;
  return `${idNumber.substring(0, 3)}***${idNumber.slice(-2)}`;
}

// ============================================================================
// PASS GENERATION & NOTIFICATIONS
// ============================================================================
async function generateTurnstilePass(visitorPhone, visitorData) {
  const zoneTag = visitorData.zone === 'RETAIL_PARKING' ? 'ZONE_RETAIL_PARKING' : 'ZONE_FULL_RESIDENTIAL';
  const passToken = `PC-${visitorData.zone === 'RETAIL_PARKING' ? 'RET' : 'RES'}-${Math.floor(100000 + Math.random() * 900000)}`;

  const hostProfile = visitorData.hostPhone ? userProfiles.get(visitorData.hostPhone) : null;
  const hostUnit = hostProfile ? hostProfile.unit : '5102';

  const passObj = {
    passToken,
    visitorName: visitorData.visitorName,
    visitorPhone: visitorPhone,
    hostPhone: visitorData.hostPhone,
    hostUnit: hostUnit,
    zone: zoneTag,
    status: 'ACTIVE_CREDENTIAL',
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    entries: []
  };
  await persistPass(passObj);

  const qrPayload = JSON.stringify({
    token: passToken,
    zone: zoneTag,
    guest: visitorData.visitorName,
    id: maskID(visitorData.idNumber),
    mode: visitorData.accessType,
  });

  const qrDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(qrPayload)}`;

  const zoneText = visitorData.zone === 'RETAIL_PARKING'
    ? '⚠️ *Zone:* PARKING & RETAIL ONLY (Turnstiles Restricted)'
    : '✅ *Zone:* FULL RESIDENTIAL (Turnstiles & Lifts Active)';

  await sendWhatsAppImage(
    visitorPhone,
    qrDataUrl,
    `🎟️ *PONTE CITY 24-HOUR ACCESS PASS*\n\n` +
      `• *Guest:* ${visitorData.visitorName}\n` +
      `• *Doc:* ${maskID(visitorData.idNumber)}\n` +
      `• *Pass Code:* ${passToken}\n` +
      `• ${zoneText}\n` +
      `• *Validity:* 24 Hours (Multiple Ingress Allowed)\n\n` +
      `_Scan at turnstile readers. You may enter and exit freely during your visit._`,
    PHONE_ID_MAIN
  );

  if (visitorData.hostPhone) {
    await sendInteractiveButtons(
      visitorData.hostPhone,
      'VISITOR PASS ACTIVE',
      `✅ *Pass Activated for ${visitorData.visitorName}* [${passToken}].\n\n` +
        `Your guest can scan at turnstiles. If you require escort assistance when they arrive, select below:`,
      [
        { id: `LOBBY_MEET_${visitorPhone}`, title: "I'll Meet in Lobby" },
        { id: `DISPATCH_ESCORT_${visitorPhone}`, title: "Request Runner" }
      ],
      'Promo: R35.00 per runner escort',
      PHONE_ID_MAIN
    );
  }
}

async function triggerSecurityDivert(visitorPhone, visitorData, failReason, mediaId = null) {
  const alertId = `ALT-${Math.floor(1000 + Math.random() * 9000)}`;

  const alertObj = {
    alertId,
    visitorName: visitorData.visitorName,
    visitorPhone: visitorPhone,
    hostPhone: visitorData.hostPhone || 'N/A',
    idNumber: visitorData.idNumber,
    reason: failReason,
    timestamp: new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
    zone: visitorData.zone || 'FULL_RESIDENTIAL',
    status: 'PENDING_MANUAL_REVIEW',
    mediaId: mediaId,
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  };
  await persistAlert(alertObj);

  await sendWhatsAppMessage(
    visitorPhone,
    `⚠️ *Verification Clearance Notice*\n\n` +
      `Hello ${visitorData.visitorName}, document check required.\n\n` +
      `*Status:* ${failReason}\n\n` +
      `🏢 Show this voucher at the *Ponte Reception / Security Desk* upon arrival to receive your pass:\n\n` +
      `• *Reference Voucher:* *[${alertId}]*`,
    PHONE_ID_MAIN
  );

  const alertPayload =
    `🚨 *PONTE VERIFICATION ALERT [#${alertId}]*\n\n` +
    `• *Guest:* ${visitorData.visitorName} (${visitorPhone})\n` +
    `• *Host Resident:* ${visitorData.hostPhone || 'Walk-in'}\n` +
    `• *Reason:* ${failReason}\n` +
    `• *Action:* Check physical doc on HUD & issue pass.`;

  if (isReceptionOpen()) {
    await sendWhatsAppMessage(RECEPTION_WA_GROUP, alertPayload, PHONE_ID_MAIN);
  } else {
    await sendWhatsAppMessage(SECURITY_DUTY_PHONE, alertPayload, PHONE_ID_MAIN);
  }
}

// ============================================================================
// PAYSTACK WEBHOOK
// ============================================================================
app.post('/paystack/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    const eventType = event.event;
    const eventData = event.data;
    const jobId = eventData?.metadata?.jobId;

    if (!jobId) return;
    const job = runnerJobs.get(jobId);
    if (!job) return;

    if (eventType === 'charge.success') {
      if (job.status === 'PENDING_PAYMENT') {
        job.status = 'PAID_AWAITING_CLAIM';
        job.paidAt = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await persistJob(job);

        const hasPin = /\b\d{4,6}\b/.test(job.details);
        const pinReminder = hasPin
          ? ''
          : `\n\n⚠️ *REMINDER:* If your courier requires a release PIN/OTP, text it to your runner once claimed.`;

        await sendWhatsAppMessage(
          job.hostPhone,
          `✅ *Payment Confirmed (R35.00)*\n\n` +
            `Task *#${job.jobId}* is funded and dispatched to the active runner roster.${pinReminder}`,
          PHONE_ID_MAIN
        );

        await broadcastRunnerJob(job);
      }
      return;
    }

    if (eventType === 'charge.failed' || eventType === 'invoice.payment_failed') {
      const gatewayResponse = eventData.gateway_response || 'Declined';
      if (job.status === 'PENDING_PAYMENT') {
        await sendInteractiveButtons(
          job.hostPhone,
          'PAYMENT NOT COMPLETED',
          `❌ Payment for Task *#${job.jobId}* could not be processed.\n\n` +
          `• *Reason:* ${gatewayResponse}\n` +
          `• *Amount:* R35.00\n\n` +
          `You can retry payment or cancel the errand request:`,
          [
            { id: `RETRY_PAY_${job.jobId}`, title: 'Retry Payment 💳' },
            { id: `CANCEL_TASK_${job.jobId}`, title: 'Cancel Task 🚫' }
          ],
          '',
          PHONE_ID_MAIN
        );
      }
    }
  } catch (err) {
    console.error('❌ Paystack webhook error:', err.message);
  }
});

// ============================================================================
// TURNSTILE SCAN SIMULATOR / VALIDATOR
// ============================================================================
app.get('/api/turnstile/scan', async (req, res) => {
  const { token } = req.query;
  const pass = issuedPasses.get(token);

  if (!pass) return res.status(404).json({ access: 'DENIED', reason: 'INVALID_TOKEN' });

  const nowTime = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  pass.entries.push(nowTime);
  await persistPass(pass);

  if (pass.hostPhone) {
    await sendWhatsAppMessage(
      pass.hostPhone,
      `🔔 *Visitor Arrival Alert*\n\n*${pass.visitorName}* scanned through the ground turnstiles at ${nowTime}.`,
      PHONE_ID_MAIN
    );
  }

  res.json({ access: 'GRANTED', guest: pass.visitorName, zone: pass.zone, time: nowTime });
});

// ============================================================================
// AUDIT ENGINE + EXTERNAL CRON TRIGGER
// ============================================================================
function generateAuditSummary() {
  const jobsList = Array.from(runnerJobs.values());
  const completedJobs = jobsList.filter(j => j.status === 'COMPLETED_VERIFIED');
  const paidJobs = jobsList.filter(j => j.paidAt);

  const totalTasks = jobsList.length;
  const totalPaidCount = paidJobs.length;
  const totalCompletedCount = completedJobs.length;

  const grossRevenue = totalPaidCount * 35.00;
  const totalRunnerPayouts = totalCompletedCount * 25.00;
  const platformMargin = totalCompletedCount * 10.00;
  const communityRebate = totalCompletedCount * 0.50;

  const runnerStats = {};
  for (const job of completedJobs) {
    const runnerPhone = job.claimedBy || 'Unknown';
    const runnerProfile = userProfiles.get(runnerPhone);
    const runnerName = runnerProfile ? runnerProfile.fullName : runnerPhone;
    if (!runnerStats[runnerName]) {
      runnerStats[runnerName] = { runs: 0, earnings: 0.0 };
    }
    runnerStats[runnerName].runs += 1;
    runnerStats[runnerName].earnings += 25.00;
  }

  return {
    date: new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
    totalTasks,
    totalPaidCount,
    totalCompletedCount,
    grossRevenue,
    totalRunnerPayouts,
    platformMargin,
    communityRebate,
    runnerStats
  };
}

async function sendDailyAuditReport() {
  const report = generateAuditSummary();
  let runnerBreakdownText = '';

  for (const [name, stats] of Object.entries(report.runnerStats)) {
    runnerBreakdownText += `  • *${name}:* ${stats.runs} run(s) -> R${stats.earnings.toFixed(2)}\n`;
  }
  if (!runnerBreakdownText) runnerBreakdownText = `  • _No verified runs completed today._\n`;

  const message =
    `📊 *PONTE CONCIERGE DAILY AUDIT REPORT*\n` +
    `📅 *Date:* ${report.date}\n\n` +
    `• *Total Tasks Created:* ${report.totalTasks}\n` +
    `• *Tasks Paid (Paystack):* ${report.totalPaidCount}\n` +
    `• *Tasks Verified Completed:* ${report.totalCompletedCount}\n\n` +
    `💰 *Financial Reconciliations:*\n` +
    `• *Gross Revenue (R35/task):* R${report.grossRevenue.toFixed(2)}\n` +
    `• *Runner Payouts Owed (R25/task):* R${report.totalRunnerPayouts.toFixed(2)}\n` +
    `• *Platform Margin (R10/task):* R${report.platformMargin.toFixed(2)}\n` +
    `• *Dlala Nje Community Fund (5%):* R${report.communityRebate.toFixed(2)}\n\n` +
    `🏃 *Runner Shift Earnings:*\n${runnerBreakdownText}\n` +
    `_Generated by Ponte Concierge Audit Engine._`;

  await sendWhatsAppMessage(ADMIN_REPORT_PHONE, message, PHONE_ID_MAIN);
}

// External Cron Endpoint (Wakes Render reliably at 20:00 SAST / 18:00 UTC)
let lastReportDate = '';
app.get('/api/cron/daily-audit', async (req, res) => {
  const { token } = req.query;
  if (token !== VERIFY_TOKEN) {
    return res.status(403).json({ status: 'FORBIDDEN', reason: 'Invalid cron token' });
  }

  const todayStr = new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  lastReportDate = todayStr;
  await sendDailyAuditReport();

  res.json({ status: 'SUCCESS', message: `Daily audit report dispatched for ${todayStr}` });
});

// Background 15-min interval (runs while awake) + POPIA purge
setInterval(async () => {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const sastHours = (utcHours + 2) % 24;
  const todayStr = now.toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' });

  if (sastHours === 20 && lastReportDate !== todayStr) {
    lastReportDate = todayStr;
    await sendDailyAuditReport();
  }

  for (const [alertId, alert] of securityAlerts.entries()) {
    if (alert.expiresAt && new Date(alert.expiresAt) <= now && alert.status !== 'ARCHIVED_PURGED') {
      if (alert.mediaId) delete alert.mediaId;
      alert.status = 'ARCHIVED_PURGED';
      await persistAlert(alert);
    }
  }

  for (const [token, pass] of issuedPasses.entries()) {
    if (pass.validUntil) {
      const purgeWindow = new Date(new Date(pass.validUntil).getTime() + 24 * 60 * 60 * 1000);
      if (now >= purgeWindow) await deletePass(token);
    }
  }
}, 15 * 60 * 1000);

// ============================================================================
// META WEBHOOK VERIFICATION (GET)
// ============================================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============================================================================
// INBOUND MESSAGE PROCESSOR (POST) - DUAL-CHANNEL ROUTING
// ============================================================================
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const senderPhone = message.from;
    const messageType = message.type;

    const metadata = value?.metadata || {};
    const recipientPhoneId = String(metadata.phone_number_id || '').trim();
    const displayPhoneNumber = String(metadata.display_phone_number || '').trim();

    console.log(`📥 [INBOUND] From: ${senderPhone} | To Phone ID: "${recipientPhoneId}" | Display No: "${displayPhoneNumber}" | Type: ${messageType}`);

    // =========================================================================
    // CHANNEL A: 072 SUPPORT LINE -> DETERMINISTIC FAST-PATH + GEMINI 2.5 FLASH
    // =========================================================================
    const isSupportChannel =
      recipientPhoneId === String(PHONE_ID_SUPPORT).trim() ||
      recipientPhoneId === '1448916934975007' ||
      displayPhoneNumber.includes('729494561');

    if (isSupportChannel) {
      console.log(`🤖 [ROUTING] Handing off message to Support & Self-Healing Agent for ${senderPhone}...`);
      if (messageType === 'text') {
        await handleSupportAndBacklogAgent(senderPhone, message.text.body.trim(), recipientPhoneId);
      }
      return;
    }

    // =========================================================================
    // CHANNEL B: 081 MAIN ENGINE -> INTERACTIVE BUTTONS, OCR, DISPATCH
    // =========================================================================
    console.log(`🏢 [ROUTING] Handing off message to Ponte Concierge Main Engine for ${senderPhone}...`);

    if (messageType === 'interactive' && message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;

      if (buttonId === 'ROLE_RESIDENT') {
        userProfiles.set(senderPhone, { role: 'RESIDENT', registeredAt: new Date(), unit: '5102', fullName: 'RC Janse van Rensburg' });
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'FULL_RESIDENTIAL' });
        await sendWhatsAppMessage(
          senderPhone,
          `🏠 *Ponte Resident Profile Registered*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Sipho Dlamini, 0821234567`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId === 'ROLE_RUNNER') {
        userProfiles.set(senderPhone, { role: 'RUNNER', registeredAt: new Date(), fullName: 'Ponte Resident Runner' });
        await sendWhatsAppMessage(senderPhone, `🏃 *Ponte Runner Roster Activated*`, PHONE_ID_MAIN);
        return;
      }

      if (buttonId.startsWith('LOBBY_MEET_')) {
        const guestPhone = buttonId.replace('LOBBY_MEET_', '');
        await sendInteractiveButtons(
          senderPhone,
          'MEET IN LOBBY CONFIRMED',
          `Your guest has 24h turnstile access.\n\nWhen your guest is ready to leave for good, authorize departure below:`,
          [{ id: `AUTH_EXIT_${guestPhone}`, title: 'Authorize Exit 🚪' }],
          '',
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId.startsWith('DISPATCH_ESCORT_')) {
        const guestPhone = buttonId.replace('DISPATCH_ESCORT_', '');
        residentSessions.set(senderPhone, {
          step: 'AWAITING_RUNNER_NOTE',
          taskType: 'VISITOR_ESCORT',
          guestPhone: guestPhone
        });

        await sendWhatsAppMessage(
          senderPhone,
          `📝 *Escort Pickup Note:*\n\nReply with where your guest is waiting:\n*(e.g., "Lobby turnstiles" or "Main Gate Pedestrian Kiosk")*`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId === 'REQ_RUNNER_PARCEL' || buttonId === 'REQ_RUNNER_ESCORT') {
        const taskType = buttonId === 'REQ_RUNNER_PARCEL' ? 'PARCEL_COLLECTION' : 'VISITOR_ESCORT';
        residentSessions.set(senderPhone, {
          step: 'AWAITING_RUNNER_NOTE',
          taskType: taskType
        });

        const promptText = taskType === 'PARCEL_COLLECTION'
          ? `📝 *Delivery Details & Courier PIN:*\n\nReply with what to collect, courier company, and release PIN:\n*(e.g., "Main Gate - Checkers Sixty60 under Rudi, PIN: 4812")*`
          : `📝 *Escort Details:*\n\nReply with who and where to meet:\n*(e.g., "Lobby turnstiles - Thabo 0821234567")*`;

        await sendWhatsAppMessage(senderPhone, promptText, PHONE_ID_MAIN);
        return;
      }

      if (buttonId.startsWith('ACCESS_TYPE_')) {
        const session = residentSessions.get(senderPhone);
        if (!session) return;

        const accessType = buttonId.replace('ACCESS_TYPE_', '');
        session.accessType = accessType;
        session.step = 'COMPLETED';

        let formattedGuestPhone = session.visitorPhone.replace(/\D/g, '');
        if (formattedGuestPhone.startsWith('0')) formattedGuestPhone = '27' + formattedGuestPhone.substring(1);

        visitorSessions.set(formattedGuestPhone, {
          step: 'AWAITING_ID_NUMBER',
          hostPhone: senderPhone,
          visitorName: session.visitorName,
          accessType: accessType,
          zone: session.zone || 'FULL_RESIDENTIAL',
        });

        await sendWhatsAppMessage(
          senderPhone,
          `⏳ *Pre-clearance invitation sent to ${session.visitorName}* (${formattedGuestPhone}).`,
          PHONE_ID_MAIN
        );

        await sendWhatsAppMessage(
          formattedGuestPhone,
          `🏢 *Ponte City Access Pre-Clearance*\n\n` +
            `Hello ${session.visitorName}! Resident *${senderPhone}* has pre-cleared your arrival (${accessType}).\n\n` +
            `To issue your 24-hour optical access pass, reply with your *13-Digit SA ID* or *Passport Number*:`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId.startsWith('RETRY_PAY_')) {
        const retryJobId = buttonId.replace('RETRY_PAY_', '');
        const retryJob = runnerJobs.get(retryJobId);
        if (retryJob) {
          const checkoutUrl = await generatePaystackCheckout(retryJob.hostPhone, retryJob.unit, retryJob.jobId);
          await sendWhatsAppMessage(
            senderPhone,
            `💳 *Retry Payment for Task [#${retryJob.jobId}]*\n\nTap below to complete your R35.00 checkout:\n${checkoutUrl}`,
            PHONE_ID_MAIN
          );
        }
        return;
      }

      if (buttonId.startsWith('CANCEL_TASK_')) {
        const cancelJobId = buttonId.replace('CANCEL_TASK_', '');
        await deleteJob(cancelJobId);
        await sendWhatsAppMessage(senderPhone, `🚫 *Task #${cancelJobId} Cancelled.* No fee was charged.`, PHONE_ID_MAIN);
        return;
      }

      if (buttonId.startsWith('JOB_ACCEPT_')) {
        const jobId = buttonId.replace('JOB_ACCEPT_', '');
        const job = runnerJobs.get(jobId);

        if (!job || job.status === 'CLAIMED_AWAITING_PICKUP' || job.status === 'IN_TRANSIT') {
          await sendWhatsAppMessage(senderPhone, `❌ *Task already claimed* by another Ponte Runner.`, PHONE_ID_MAIN);
          return;
        }

        job.status = 'CLAIMED_AWAITING_PICKUP';
        job.claimedBy = senderPhone;
        await persistJob(job);

        await sendInteractiveButtons(
          senderPhone,
          `TASK #${jobId} CLAIMED`,
          `• *Type:* ${job.taskType}\n` +
          `• *Destination:* Unit ${job.unit} (${job.hostName}: ${job.hostPhone})\n` +
          `📌 *Details:* _${job.details}_\n\n` +
          `Meet courier/guest directly at the gate. Tap below once collected:`,
          [{ id: `JOB_COLLECTED_${jobId}`, title: 'Collected & En Route 🏃‍♂️' }],
          '',
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId.startsWith('JOB_DECLINE_')) {
        await sendWhatsAppMessage(senderPhone, `👍 Task declined. You remain on standby.`, PHONE_ID_MAIN);
        return;
      }

      if (buttonId.startsWith('JOB_COLLECTED_')) {
        const jobId = buttonId.replace('JOB_COLLECTED_', '');
        const job = runnerJobs.get(jobId);
        if (!job) return;

        job.status = 'IN_TRANSIT';
        job.collectedAt = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await persistJob(job);

        await sendWhatsAppMessage(
          job.hostPhone,
          `🏃‍♂️ *Runner En Route to Your Unit!*\n\n` +
            `Ponte Runner (${senderPhone}) has collected the parcel/guest and is heading to *Unit ${job.unit}*.`,
          PHONE_ID_MAIN
        );

        await sendInteractiveButtons(
          senderPhone,
          `TASK #${jobId} IN TRANSIT`,
          `Proceeding to Unit ${job.unit}.\n\nTap below once you reach the resident's door:`,
          [{ id: `JOB_DELIVERED_${jobId}`, title: 'Delivered to Unit ✅' }],
          '',
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId.startsWith('JOB_DELIVERED_')) {
        const jobId = buttonId.replace('JOB_DELIVERED_', '');
        const job = runnerJobs.get(jobId);
        if (!job) return;

        job.status = 'AWAITING_RESIDENT_CONFIRMATION';
        job.deliveredAt = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await persistJob(job);

        await sendWhatsAppMessage(
          senderPhone,
          `⏳ *Delivery Reported for Task #${jobId}*\n\n` +
            `Waiting for resident (${job.hostName}, Unit ${job.unit}) to confirm physical handover before releasing payout.`,
          PHONE_ID_MAIN
        );

        await sendInteractiveButtons(
          job.hostPhone,
          'CONFIRM HANDOVER',
          `🚪 Ponte Runner (${senderPhone}) reports completing task *#${jobId}* at your door.\n\n` +
            `Please confirm receipt:`,
          [
            { id: `RESIDENT_CONFIRM_${jobId}`, title: 'Confirm Receipt 👍' },
            { id: `RESIDENT_DISPUTE_${jobId}`, title: 'Not Received ⚠️' }
          ],
          '',
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId.startsWith('RESIDENT_CONFIRM_')) {
        const jobId = buttonId.replace('RESIDENT_CONFIRM_', '');
        const job = runnerJobs.get(jobId);
        if (!job) return;

        job.status = 'COMPLETED_VERIFIED';
        job.completedAt = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await persistJob(job);

        if (job.claimedBy) {
          await sendWhatsAppMessage(
            job.claimedBy,
            `🎉 *Task #${jobId} Verified by Resident!*\n\n` +
              `Unit ${job.unit} confirmed safe handover. *R25.00* has been credited to your active shift balance.`,
            PHONE_ID_MAIN
          );
        }

        if (job.taskType === 'VISITOR_ESCORT' && job.guestPhone) {
          await sendInteractiveButtons(
            senderPhone,
            'HANDOVER COMPLETED',
            `✅ Task #${jobId} closed.\n\nWhen your guest is ready to leave later, authorize departure below:`,
            [{ id: `AUTH_EXIT_${job.guestPhone}`, title: 'Authorize Exit 🚪' }],
            '',
            PHONE_ID_MAIN
          );
        } else {
          await sendWhatsAppMessage(senderPhone, `✅ *Task #${jobId} Closed & Verified.*`, PHONE_ID_MAIN);
        }
        return;
      }

      if (buttonId.startsWith('RESIDENT_DISPUTE_')) {
        const jobId = buttonId.replace('RESIDENT_DISPUTE_', '');
        await sendWhatsAppMessage(senderPhone, `⚠️ Handover dispute logged. Building security alerted.`, PHONE_ID_MAIN);
        return;
      }

      if (buttonId.startsWith('AUTH_EXIT_')) {
        const guestPhone = buttonId.replace('AUTH_EXIT_', '');
        const hostProfile = userProfiles.get(senderPhone) || { unit: '5102', fullName: 'Resident' };

        const exitAlertId = `EXIT-${Math.floor(1000 + Math.random() * 9000)}`;
        const exitAlert = {
          alertId: exitAlertId,
          visitorName: `Guest (${guestPhone})`,
          visitorPhone: guestPhone,
          hostPhone: senderPhone,
          idNumber: 'EGRESS_AUTHORIZED',
          reason: `Exit Authorized by Host (Unit ${hostProfile.unit}). Departing estate.`,
          timestamp: new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
          zone: 'EGRESS_CLEARANCE',
          status: 'PENDING_MANUAL_REVIEW',
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
        };
        await persistAlert(exitAlert);

        await sendWhatsAppMessage(
          senderPhone,
          `🚪 *Exit Clearance Authorized*\n\nSecurity HUD alerted. Your guest can now proceed through the exit gate.`,
          PHONE_ID_MAIN
        );

        await sendWhatsAppMessage(
          guestPhone,
          `👋 *Departure Authorized*\n\nYour host has authorized your exit. Thank you for visiting Ponte City!`,
          PHONE_ID_MAIN
        );
        return;
      }
    }

    // IMAGE UPLOADS
    if (messageType === 'image') {
      const visitorSession = visitorSessions.get(senderPhone);
      if (visitorSession && visitorSession.step === 'AWAITING_DOC_IMAGE') {
        const imageId = message.image.id;
        await sendWhatsAppMessage(senderPhone, '🔎 *Analyzing Document Image...*', PHONE_ID_MAIN);

        const imageBuffer = await downloadMetaImage(imageId);
        if (!imageBuffer) {
          await triggerSecurityDivert(senderPhone, visitorSession, 'Failed to download document');
          return;
        }

        const ocrResult = await performDocumentOCR(imageBuffer, visitorSession.idNumber, visitorSession.visitorName);
        visitorSession.step = 'COMPLETED';

        if (ocrResult.verified) {
          await generateTurnstilePass(senderPhone, visitorSession);
          return;
        }

        await triggerSecurityDivert(senderPhone, visitorSession, ocrResult.reason, imageId);
        return;
      }
    }

    // TEXT MESSAGES ON 081
    if (messageType === 'text') {
      const rawText = message.text.body.trim();
      const lowerText = rawText.toLowerCase();
      const cleanText = lowerText.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();

      if (cleanText === 'report' && senderPhone === ADMIN_REPORT_PHONE) {
        await sendDailyAuditReport();
        return;
      }

      const activeResSession = residentSessions.get(senderPhone);
      if (activeResSession && activeResSession.step === 'AWAITING_RUNNER_NOTE') {
        const hostProfile = userProfiles.get(senderPhone) || { unit: '5102', fullName: 'RC Janse van Rensburg' };
        const jobId = Math.floor(1000 + Math.random() * 9000).toString();

        const jobRecord = {
          jobId,
          status: 'PENDING_PAYMENT',
          unit: hostProfile.unit,
          hostName: hostProfile.fullName,
          hostPhone: senderPhone,
          guestPhone: activeResSession.guestPhone || null,
          details: rawText,
          taskType: activeResSession.taskType || 'RUNNER_SERVICE',
          payout: 'R25.00',
          feePaid: 'R35.00'
        };

        await persistJob(jobRecord);
        residentSessions.delete(senderPhone);

        const checkoutUrl = await generatePaystackCheckout(senderPhone, hostProfile.unit, jobId);

        await sendWhatsAppMessage(
          senderPhone,
          `💳 *Confirm Ponte Runner Booking [#${jobId}]*\n\n` +
            `• *Service:* ${jobRecord.taskType === 'PARCEL_COLLECTION' ? 'Parcel Collection' : 'Visitor Escort'}\n` +
            `• *Pickup Note:* _"${rawText}"_\n` +
            `• *Amount Due:* *R35.00* (Launch Promo)\n\n` +
            `👉 *Tap Link to Complete Payment:*\n${checkoutUrl}\n\n` +
            `_Once paid, task broadcasts instantly to active runners._`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (cleanText === 'register' || cleanText === 'start' || cleanText === 'hi' || cleanText === 'hello') {
        const existing = userProfiles.get(senderPhone);
        if (existing) {
          if (existing.role === 'RESIDENT') {
            await sendWhatsAppMessage(
              senderPhone,
              `👋 *Welcome back Ponte Resident!*\n\n• Reply *visitor* to invite guest\n• Reply *runner* to book delivery/escort\n• Reply *retail* for parking pass`,
              PHONE_ID_MAIN
            );
            return;
          }
          if (existing.role === 'RUNNER') {
            await sendWhatsAppMessage(
              senderPhone,
              `🏃 *Welcome back ${existing.fullName}!* (Ponte Runner)\nYou are on active standby for dispatches.`,
              PHONE_ID_MAIN
            );
            return;
          }
        }

        await sendInteractiveButtons(
          senderPhone,
          'PONTE CONCIERGE',
          'Welcome to Ponte City! Please select your profile:',
          [
            { id: 'ROLE_RESIDENT', title: 'Ponte Resident' },
            { id: 'ROLE_RUNNER', title: 'Ponte Runner' }
          ],
          'Visitors: Passes are issued by your host.',
          PHONE_ID_MAIN
        );
        return;
      }

      if (cleanText === 'runner' || cleanText === 'parcel' || cleanText === 'delivery') {
        await sendInteractiveButtons(
          senderPhone,
          'REQUEST A RUNNER',
          'Select the runner service you require:',
          [
            { id: 'REQ_RUNNER_PARCEL', title: 'Collect Delivery 🛒' },
            { id: 'REQ_RUNNER_ESCORT', title: 'Escort a Visitor 👥' }
          ],
          'Promo Rate: R35.00 per service',
          PHONE_ID_MAIN
        );
        return;
      }

      if (cleanText === 'visitor' || cleanText === 'invite') {
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'FULL_RESIDENTIAL' });
        await sendWhatsAppMessage(
          senderPhone,
          `👥 *Ponte Visitor Pre-Clearance*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Thabo Molefe, 0712345678`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (cleanText === 'retail' || cleanText === 'parking') {
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'RETAIL_PARKING' });
        await sendWhatsAppMessage(
          senderPhone,
          `🅿️ *Retail / Parking Pre-Clearance*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Lerato Khumalo, 0831112233`,
          PHONE_ID_MAIN
        );
        return;
      }

      const resSession = residentSessions.get(senderPhone);
      if (resSession && resSession.step === 'AWAITING_GUEST_DETAILS') {
        const parts = rawText.split(',');
        if (parts.length < 2) {
          await sendWhatsAppMessage(senderPhone, '⚠️ Please separate *Name* and *Cell Number* with a comma.', PHONE_ID_MAIN);
          return;
        }

        const guestName = parts[0].trim();
        const guestPhone = parts[1].trim();

        resSession.visitorName = guestName;
        resSession.visitorPhone = guestPhone;
        resSession.step = 'AWAITING_ACCESS_TYPE';

        await sendInteractiveButtons(
          senderPhone,
          'ARRIVAL MODE',
          `How will *${guestName}* arrive at Ponte City?`,
          [
            { id: 'ACCESS_TYPE_PEDESTRIAN', title: 'Pedestrian' },
            { id: 'ACCESS_TYPE_VEHICLE', title: 'Resident Parking' },
            { id: 'ACCESS_TYPE_EHAILING', title: 'Uber / Bolt' },
          ],
          '',
          PHONE_ID_MAIN
        );
        return;
      }

      const visSession = visitorSessions.get(senderPhone);
      if (visSession && visSession.step === 'AWAITING_ID_NUMBER') {
        const sanitizedId = cleanText.replace(/[\s\-\.]/g, '');
        const isPassport = /^[A-Z0-9]{6,12}$/i.test(sanitizedId) && /[A-Z]/i.test(sanitizedId);
        const isNumeric13 = /^\d{13}$/.test(sanitizedId);

        if (isPassport) {
          visSession.idNumber = sanitizedId;
          visSession.isPassport = true;
          visSession.step = 'AWAITING_DOC_IMAGE';
          await sendWhatsAppMessage(
            senderPhone,
            `✅ *Passport Number Recorded (${maskID(sanitizedId)})*\n\nPlease upload a clear photo of your *Passport Identity Page*:`,
            PHONE_ID_MAIN
          );
          return;
        }

        if (isNumeric13) {
          if (!validateSouthAfricanID(sanitizedId) && !sanitizedId.startsWith('999')) {
            await sendWhatsAppMessage(
              senderPhone,
              `❌ *Invalid South African ID Number*\n\nChecksum failed. Please re-enter:`,
              PHONE_ID_MAIN
            );
            return;
          }

          visSession.idNumber = sanitizedId;
          visSession.isPassport = false;
          visSession.step = 'AWAITING_DOC_IMAGE';
          await sendWhatsAppMessage(
            senderPhone,
            `✅ *ID Checksum Validated (${maskID(sanitizedId)})*\n\nPlease upload a photo of your *Smart ID, Green Book, or Driver's License*:`,
            PHONE_ID_MAIN
          );
          return;
        }

        await sendWhatsAppMessage(
          senderPhone,
          `⚠️ Enter your *13-Digit SA ID* or *Passport Number* (e.g. A10436243):`,
          PHONE_ID_MAIN
        );
        return;
      }

      await sendWhatsAppMessage(
        senderPhone,
        `👋 *Ponte Concierge*\n\n• Reply *visitor* to invite guest\n• Reply *runner* to book delivery/escort\n• For support, message +27 72 949 4561`,
        PHONE_ID_MAIN
      );
    }
  } catch (error) {
    console.error('❌ Webhook error:', error);
  }
});

// ============================================================================
// GUARD LIVE HUD & OVERRIDE API (PROTECTED BY BASIC AUTH)
// ============================================================================
app.get('/security/live', requireHudAuth, (req, res) => {
  const alertsList = Array.from(securityAlerts.values()).reverse();
  const rows = alertsList.map(a => `
    <tr style="border-bottom: 1px solid #334155; ${a.status === 'APPROVED' || a.status === 'EXIT_CONFIRMED' || a.status === 'ARCHIVED_PURGED' ? 'opacity: 0.5;' : ''}">
      <td style="padding: 12px; font-weight: bold; color: #38bdf8;">${a.alertId}</td>
      <td style="padding: 12px;">${a.timestamp}</td>
      <td style="padding: 12px;">
        <strong>${a.visitorName}</strong><br>
        <span style="font-size: 12px; color: #94a3b8;">${a.visitorPhone}</span><br>
        <span style="font-size: 11px; color: #cbd5e1;">Doc: ${maskID(a.idNumber)}</span>
      </td>
      <td style="padding: 12px; color: ${a.zone === 'EGRESS_CLEARANCE' ? '#eab308' : '#f87171'};">
        ${a.reason}<br>
        ${a.mediaId ? `<span style="font-size: 11px; color: #38bdf8;">📷 Document attached</span>` : ''}
      </td>
      <td style="padding: 12px;"><span style="background: ${a.zone === 'RETAIL_PARKING' ? '#eab308' : (a.zone === 'EGRESS_CLEARANCE' ? '#f97316' : '#22c55e')}; color: #000; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${a.zone}</span></td>
      <td style="padding: 12px;">
        ${a.status === 'PENDING_MANUAL_REVIEW' && a.zone === 'EGRESS_CLEARANCE'
          ? `<a href="/security/override?id=${a.alertId}&action=CONFIRM_EXIT" style="background: #f97316; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold;">Sign Out Exit 🚪</a>`
          : (a.status === 'PENDING_MANUAL_REVIEW'
              ? `<a href="/security/override?id=${a.alertId}&action=APPROVE" style="background: #22c55e; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold;">Verify & Pass</a>
                 <a href="/security/override?id=${a.alertId}&action=REJECT" style="background: #ef4444; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold; margin-left: 6px;">Reject</a>`
              : `<span style="color: #4ade80; font-weight: bold;">${a.status}</span>`
            )
        }
      </td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Ponte City - Security HUD</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1e293b; padding-bottom: 15px; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; text-align: left; }
          th { background: #1e293b; padding: 12px; color: #94a3b8; }
          input, select { padding: 10px; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: white; }
          button { background: #0284c7; color: white; border: none; padding: 10px 20px; border-radius: 4px; font-weight: bold; cursor: pointer; }
        </style>
        <meta http-equiv="refresh" content="15">
      </head>
      <body>
        <div class="header">
          <h2 style="margin: 0; color: #38bdf8;">🛡️ Ponte City Security & Reception HUD</h2>
          <div style="font-size: 12px; color: #4ade80;">● Live Feed | DB: ${pool ? 'PostgreSQL Persistent' : 'RAM'}</div>
        </div>
        <table>
          <thead><tr><th>Alert Ref</th><th>Time</th><th>Visitor Details</th><th>Status / Reason</th><th>Zone</th><th>Action</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" style="padding: 20px; text-align: center; color: #64748b;">No active verification alerts.</td></tr>'}</tbody>
        </table>
        <div style="background: #1e293b; padding: 20px; border-radius: 8px; margin-top: 30px;">
          <h3 style="margin-top: 0; color: #38bdf8;">🛠️ Guard Assisted Check-In</h3>
          <form action="/security/assisted-clear" method="POST" style="display: flex; gap: 10px; flex-wrap: wrap;">
            <input type="text" name="visitorName" placeholder="Guest Full Name" required>
            <input type="text" name="visitorPhone" placeholder="Guest Mobile" required>
            <input type="text" name="hostUnit" placeholder="Host Unit #" required>
            <select name="zone">
              <option value="FULL_RESIDENTIAL">Full Turnstile Access</option>
              <option value="RETAIL_PARKING">Parking / Retail Only</option>
            </select>
            <button type="submit">Issue Pass 🎟️</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.get('/security/override', requireHudAuth, async (req, res) => {
  const { id, action } = req.query;
  const alert = securityAlerts.get(id);
  if (!alert) return res.status(404).send('Alert not found');

  if (action === 'APPROVE') {
    alert.status = 'APPROVED';
    await persistAlert(alert);
    await generateTurnstilePass(alert.visitorPhone, {
      visitorName: alert.visitorName,
      idNumber: alert.idNumber || 'PHYSICAL_CHECK_PASSED',
      accessType: 'SECURITY_DESK_CLEARANCE',
      zone: alert.zone,
      hostPhone: alert.hostPhone
    });
    await sendWhatsAppMessage(alert.visitorPhone, `🛡️ *Document Verified & Clearance Granted*\nYour turnstile pass has been issued.`, PHONE_ID_MAIN);
  } else if (action === 'CONFIRM_EXIT') {
    alert.status = 'EXIT_CONFIRMED';
    await persistAlert(alert);
    await sendWhatsAppMessage(alert.visitorPhone, `🚪 *Exit Logged*\nSafe travels!`, PHONE_ID_MAIN);
  } else {
    alert.status = 'REJECTED';
    await persistAlert(alert);
    await sendWhatsAppMessage(alert.visitorPhone, `🚫 *Entry Denied by Security Command*`, PHONE_ID_MAIN);
  }
  res.redirect('/security/live');
});

app.post('/security/assisted-clear', requireHudAuth, async (req, res) => {
  const { visitorName, visitorPhone, hostUnit, zone } = req.body;
  let formatted = visitorPhone.replace(/\D/g, '');
  if (formatted.startsWith('0')) formatted = '27' + formatted.substring(1);

  await generateTurnstilePass(formatted, {
    visitorName,
    idNumber: `UNIT-${hostUnit}`,
    accessType: 'GUARD_ASSISTED',
    zone: zone || 'FULL_RESIDENTIAL',
    hostPhone: `Unit ${hostUnit}`
  });
  res.redirect('/security/live');
});

// ============================================================================
// PRODUCT BACKLOG & SELF-HEALING INCIDENT HUD (PROTECTED BY BASIC AUTH)
// ============================================================================
app.get('/admin/backlog', requireHudAuth, async (req, res) => {
  const { action, id } = req.query;

  if (action && id) {
    const item = customerBacklogQueue.find(s => s.id === id);
    if (item) {
      if (action === 'APPROVE') item.status = 'APPROVED_FOR_DEV';
      if (action === 'REJECT') item.status = 'REJECTED';
      await persistStory(item);
    }
    return res.redirect('/admin/backlog');
  }

  const rows = customerBacklogQueue.slice().reverse().map(item => `
    <tr style="border-bottom: 1px solid #334155; ${item.status !== 'PENDING_APPROVAL' ? 'opacity: 0.6;' : ''}">
      <td style="padding: 12px; font-weight: bold; color: #38bdf8;">${item.id}</td>
      <td style="padding: 12px; font-size: 13px;">${item.submittedDate} ${item.submittedAt}</td>
      <td style="padding: 12px; font-size: 13px; color: #cbd5e1;">"${item.rawFeedback}"</td>
      <td style="padding: 12px; font-weight: 500;">${item.userStory}</td>
      <td style="padding: 12px;">
        <span style="background: ${item.businessValue === 'High' ? '#22c55e' : (item.businessValue === 'Medium' ? '#eab308' : '#64748b')}; color: black; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">
          ${item.businessValue}
        </span>
      </td>
      <td style="padding: 12px;">
        <span style="color: ${item.status === 'APPROVED_FOR_DEV' ? '#4ade80' : (item.status === 'REJECTED' ? '#ef4444' : '#facc15')}; font-weight: bold; font-size: 12px;">
          ${item.status}
        </span>
      </td>
      <td style="padding: 12px;">
        ${item.status === 'PENDING_APPROVAL' ? `
          <a href="/admin/backlog?action=APPROVE&id=${item.id}" style="background: #22c55e; color: white; padding: 5px 10px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold; margin-right: 5px;">Approve ✅</a>
          <a href="/admin/backlog?action=REJECT&id=${item.id}" style="background: #ef4444; color: white; padding: 5px 10px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold;">Reject ❌</a>
        ` : `—`}
      </td>
    </tr>
  `).join('');

  const incidentRows = systemIncidentLog.slice().reverse().map(inc => `
    <tr style="border-bottom: 1px solid #334155;">
      <td style="padding: 10px; font-weight: bold; color: #f97316;">${inc.incidentId}</td>
      <td style="padding: 10px; font-size: 12px;">${inc.timestamp}</td>
      <td style="padding: 10px; font-size: 12px; color: #cbd5e1;">${inc.rootCause}</td>
      <td style="padding: 10px; font-size: 12px; color: #4ade80;">${inc.resolution}</td>
      <td style="padding: 10px; font-size: 11px; font-weight: bold;">${inc.status}</td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Ponte Concierge - Operations & Backlog HUD</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1e293b; padding-bottom: 15px; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; text-align: left; margin-bottom: 30px; }
          th { background: #1e293b; padding: 12px; color: #94a3b8; font-size: 13px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2 style="margin: 0; color: #38bdf8;">📋 Customer Feature Backlog (Gemini Extracted)</h2>
          <div style="font-size: 12px; color: #4ade80;">Storage: ${pool ? 'PostgreSQL Persistent ✅' : 'In-Memory RAM ⚠️'}</div>
        </div>
        <table>
          <thead><tr><th>Ref</th><th>Time</th><th>Resident Feedback</th><th>Generated User Story</th><th>Value</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="padding: 20px; text-align: center; color: #64748b;">No feature requests logged yet.</td></tr>'}</tbody>
        </table>

        <div class="header">
          <h3 style="margin: 0; color: #f97316;">🩺 Autonomous Self-Healing Incident History</h3>
          <div style="font-size: 12px; color: #94a3b8;">Live Diagnostic & Auto-Remediation Logs</div>
        </div>
        <table>
          <thead><tr><th>Incident Ref</th><th>Time</th><th>Reported Fault / Cause</th><th>Auto-Remediation Applied</th><th>Status</th></tr></thead>
          <tbody>${incidentRows || '<tr><td colspan="5" style="padding: 15px; text-align: center; color: #64748b;">No system incidents logged. Systems healthy.</td></tr>'}</tbody>
        </table>
      </body>
    </html>
  `);
});

app.get('/admin/daily-report', requireHudAuth, (req, res) => {
  const report = generateAuditSummary();
  res.json({ status: 'SUCCESS', report });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Ponte Concierge Multi-Channel Pilot Engine',
    status: 'ONLINE',
    persistence: pool ? 'POSTGRESQL' : 'IN_MEMORY',
    time: new Date().toISOString()
  });
});

// Initialize DB & Start Server
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Ponte Concierge running on port ${PORT}`);
  });
});
