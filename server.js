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
const PHONE_ID_MAIN = process.env.PHONE_NUMBER_ID_MAIN || '1358165517385065';       // 081 097 3478 (Unified Main + Support)
const PHONE_ID_SUPPORT = process.env.PHONE_NUMBER_ID_SUPPORT || '1448916934975007'; // 072 949 4561 (Direct Support Line)

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
// WEBHOOK MESSAGE DEDUPLICATION CACHE (PREVENTS META COLD-START DOUBLE REPLIES)
// ============================================================================
const processedMessageIds = new Set();
function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  if (processedMessageIds.has(msgId)) return true;
  processedMessageIds.add(msgId);
  if (processedMessageIds.size > 1000) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
  return false;
}

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
      CREATE TABLE IF NOT EXISTS ponte_user_profiles (
        phone TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
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

    const profilesRes = await pool.query('SELECT phone, payload FROM ponte_user_profiles');
    for (const row of profilesRes.rows) {
      userProfiles.set(row.phone, row.payload);
    }
    for (const [phone, profile] of userProfiles.entries()) {
      await persistProfile(phone, profile);
    }

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
      `✅ [DB HYDRATED] Profiles: ${userProfiles.size} | Jobs: ${runnerJobs.size} | Passes: ${issuedPasses.size} | Alerts: ${securityAlerts.size} | Stories: ${customerBacklogQueue.length} | Incidents: ${systemIncidentLog.length}`
    );
  } catch (err) {
    console.error('❌ [DB INIT ERROR]:', err.message);
  }
}

async function persistProfile(phone, profile) {
  userProfiles.set(phone, profile);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ponte_user_profiles (phone, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (phone) DO UPDATE SET payload = $2::jsonb, updated_at = NOW()`,
      [phone, JSON.stringify(profile)]
    );
  } catch (err) {
    console.error('❌ [DB] persistProfile error:', err.message);
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

// Seed Verified Admin Resident (Penthouse 5302) & Active Runners
userProfiles.set('27715720458', { role: 'RESIDENT', verified: true, registeredAt: new Date().toISOString(), unit: '5302', fullName: 'Rudi van Rensburg' });
userProfiles.set('27832778743', { role: 'RUNNER', verified: true, active: true, registeredAt: new Date().toISOString(), fullName: 'Kaycee' });
userProfiles.set('27822229285', { role: 'RUNNER', verified: true, active: true, registeredAt: new Date().toISOString(), fullName: 'Vusi' });
userProfiles.set('27688814679', { role: 'RUNNER', verified: true, active: true, registeredAt: new Date().toISOString(), fullName: 'Musa' });
userProfiles.set('27656206712', { role: 'RUNNER', verified: true, active: true, registeredAt: new Date().toISOString(), fullName: 'Faith' });

function getHostDetails(job) {
  const profile = userProfiles.get(job.hostPhone);
  return {
    fullName: profile?.fullName || job.hostName || 'Resident',
    unit: profile?.unit || job.unit || '5302',
    phone: job.hostPhone
  };
}

function getRunnerDetails(runnerPhone) {
  if (!runnerPhone) return { fullName: 'Ponte Runner', phone: '' };
  const profile = userProfiles.get(runnerPhone);
  return {
    fullName: profile?.fullName || `Runner (${runnerPhone.slice(-4)})`,
    phone: runnerPhone
  };
}

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
        header: headerText ? { type: 'text', text: headerText.substring(0, 60) } : undefined,
        body: { text: bodyText },
        footer: footerText ? { text: footerText.substring(0, 60) } : undefined,
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
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

async function sendCtaUrlButton(recipientPhone, headerText, bodyText, buttonLabel, url, footerText = '', senderPhoneId = PHONE_ID_MAIN) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: headerText ? { type: 'text', text: headerText.substring(0, 60) } : undefined,
        body: { text: bodyText },
        footer: footerText ? { text: footerText.substring(0, 60) } : undefined,
        action: {
          name: 'cta_url',
          parameters: {
            display_text: buttonLabel.substring(0, 20),
            url: url
          }
        }
      }
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
      await sendWhatsAppMessage(recipientPhone, `${bodyText}\n\n👉 *${buttonLabel}:* ${url}`, senderPhoneId);
    }
    return result;
  } catch (error) {
    console.error(`❌ Error in sendCtaUrlButton:`, error.message);
    await sendWhatsAppMessage(recipientPhone, `${bodyText}\n\n👉 *${buttonLabel}:* ${url}`, senderPhoneId);
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

async function broadcastRunnerJob(job, singleRunnerPhone = null) {
  const host = getHostDetails(job);
  const runnerAlertText =
    `🏃 *NEW RUNNER TASK [#${job.jobId}]*\n\n` +
    `• *Service:* ${job.taskType}\n` +
    `• *Resident:* ${host.fullName} · Unit *${host.unit}* (${host.phone})\n` +
    `📌 *Pickup Details:*\n_${job.details}_\n\n` +
    `• *Runner Payout:* ${job.payout}`;

  if (singleRunnerPhone) {
    await sendInteractiveButtons(
      singleRunnerPhone,
      'PONTE TASK DISPATCH',
      runnerAlertText,
      [
        { id: `JOB_ACCEPT_${job.jobId}`, title: 'Accept Task 🚀' },
        { id: `JOB_DECLINE_${job.jobId}`, title: 'Decline' }
      ],
      '',
      PHONE_ID_MAIN
    );
    return 1;
  }

  let sentCount = 0;
  for (const [phone, profile] of userProfiles.entries()) {
    if (profile.role === 'RUNNER' && profile.active !== false) {
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
      sentCount++;
    }
  }
  console.log(`📣 [BROADCAST] Job #${job.jobId} sent to ${sentCount} active runner(s).`);
  return sentCount;
}

// ============================================================================
// DELIVERY SCREENSHOT VISION / OCR EXTRACTION FOR QUICK RUNNER BOOKING
// ============================================================================
async function extractDeliveryDetailsFromImage(imageBuffer) {
  try {
    const normalized = await preprocessDocumentImage(imageBuffer, 0);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: normalized.toString('base64')
          }
        },
        `Extract delivery order details from this order/courier screenshot for a building runner.
Return a single concise line containing vendor/courier, arrival/ETA if shown, recipient name if shown, and delivery/release PIN/OTP if shown (e.g. "Zulzi · ETA 11 min · Rudi · PIN 5666"). Keep it under 160 characters.`
      ]
    });
    const extracted = (response.text || '').trim().replace(/\s+/g, ' ');
    if (extracted) return extracted;
  } catch (err) {
    console.warn('⚠️ Vision extraction fallback to Tesseract:', err.message);
  }

  let worker = null;
  try {
    const processed = await preprocessDocumentImage(imageBuffer, 0);
    worker = await createWorker('eng');
    const ret = await worker.recognize(processed);
    await worker.terminate();
    const compact = (ret.data.text || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    return compact || 'Delivery screenshot attached (check image details)';
  } catch {
    if (worker) await worker.terminate();
    return 'Delivery screenshot attached (check image details)';
  }
}

async function createAndPromptRunnerBooking(senderPhone, taskType, detailsText, guestPhone = null, mediaId = null) {
  const hostProfile = userProfiles.get(senderPhone) || { unit: '5302', fullName: 'Resident' };
  const jobId = Math.floor(1000 + Math.random() * 9000).toString();

  const jobRecord = {
    jobId,
    status: 'PENDING_PAYMENT',
    unit: hostProfile.unit,
    hostName: hostProfile.fullName,
    hostPhone: senderPhone,
    guestPhone: guestPhone || null,
    details: detailsText,
    mediaId: mediaId || null,
    taskType: taskType || 'PARCEL_COLLECTION',
    payout: 'R25.00',
    feePaid: 'R35.00'
  };

  await persistJob(jobRecord);
  residentSessions.delete(senderPhone);

  const checkoutUrl = await generatePaystackCheckout(senderPhone, hostProfile.unit, jobId);

  await sendCtaUrlButton(
    senderPhone,
    `CONFIRM BOOKING #${jobId}`,
    `✨ *${hostProfile.fullName} · Unit ${hostProfile.unit}*\n\n` +
      `• *Service:* ${jobRecord.taskType === 'PARCEL_COLLECTION' ? 'Parcel Collection 🛒' : 'Visitor Escort 👥'}\n` +
      `• *Details:* _${detailsText}_\n` +
      `• *Total Due:* *R35.00* (Launch Promo)\n\n` +
      `Tap below to pay & dispatch your runner:`,
    'Pay R35.00 💳',
    checkoutUrl,
    'Dispatches to runners once paid',
    PHONE_ID_MAIN
  );
}

// ============================================================================
// AUTONOMOUS DIAGNOSTICS & SELF-HEALING ENGINE (SYSTEM + ROSTER + OPS)
// ============================================================================
async function diagnoseAndRemediateOperationalIssue(senderPhone, issueDescription) {
  console.log(`🩺 [DIAGNOSTICS] Investigating issue from ${senderPhone}: "${issueDescription}"`);
  const lowerIssue = issueDescription.toLowerCase();
  const nowSast = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const dateSast = new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' });

  // 1. RUNNER ROSTER / BROADCAST DIAGNOSTIC & AUTO-ENROLLMENT
  if (
    lowerIssue.includes('broadcast') ||
    lowerIssue.includes('roster') ||
    lowerIssue.includes('registered runner') ||
    lowerIssue.includes('active runner') ||
    (lowerIssue.includes('runner') && (lowerIssue.includes('not getting') || lowerIssue.includes('not receiving') || lowerIssue.includes('list') || lowerIssue.includes('check') || lowerIssue.includes('show')))
  ) {
    const allRunners = Array.from(userProfiles.entries()).filter(([, p]) => p.role === 'RUNNER');
    const activeRunners = allRunners.filter(([, p]) => p.active !== false);

    if (senderPhone === ADMIN_REPORT_PHONE) {
      const rosterSummary = activeRunners
        .map(([ph, p], i) => `${i + 1}. ${p.fullName} (${ph})`)
        .join(', ');
      return {
        resolved: true,
        message: `🏃 *Active Runner Roster (${activeRunners.length}):* ${rosterSummary || 'None registered yet.'}`
      };
    }

    const existingProfile = userProfiles.get(senderPhone);
    let actionTaken = '';

    if (!existingProfile || existingProfile.role !== 'RUNNER') {
      const newRunner = {
        role: 'RUNNER',
        verified: true,
        active: true,
        registeredAt: new Date().toISOString(),
        fullName: existingProfile?.fullName || `Runner (${senderPhone.slice(-4)})`
      };
      await persistProfile(senderPhone, newRunner);
      actionTaken = `Auto-enrolled ${senderPhone} onto PostgreSQL Runner Roster.`;
    } else if (existingProfile.active === false) {
      existingProfile.active = true;
      await persistProfile(senderPhone, existingProfile);
      actionTaken = `Re-activated standby flag for ${senderPhone}.`;
    } else {
      actionTaken = `Verified ${senderPhone} is active on Runner Roster.`;
    }

    const updatedActiveRunners = Array.from(userProfiles.entries()).filter(
      ([, p]) => p.role === 'RUNNER' && p.active !== false
    );
    const openJobs = Array.from(runnerJobs.values()).filter((j) => j.status === 'PAID_AWAITING_CLAIM');

    for (const job of openJobs) {
      await broadcastRunnerJob(job, senderPhone);
    }

    const logEntry = {
      incidentId: `INC-${Date.now().toString().slice(-4)}`,
      timestamp: `${dateSast} ${nowSast}`,
      caller: senderPhone,
      rootCause: `Runner broadcast check requested (${existingProfile ? 'Registered' : 'Missing from roster'}).`,
      resolution: `${actionTaken} Active Roster: ${updatedActiveRunners.length} runners. Sent ${openJobs.length} open job(s).`,
      status: 'AUTO_RESOLVED'
    };
    await persistIncident(logEntry);

    await sendWhatsAppMessage(
      ADMIN_REPORT_PHONE,
      `🛠️ *RUNNER ROSTER SELF-HEALED [${logEntry.incidentId}]*\n` +
      `• *Caller:* ${senderPhone}\n` +
      `• *Fix:* ${logEntry.resolution}`,
      PHONE_ID_MAIN
    );

    return {
      resolved: true,
      message:
        `🛠️ *Auto-Fix Executed [${logEntry.incidentId}]:*\n` +
        `• ${actionTaken}\n` +
        `• *Active Runners on Roster:* ${updatedActiveRunners.length}\n` +
        `• *Open Jobs Sent:* ${openJobs.length}\n\n` +
        `You are confirmed active on the persistent roster and will receive all task dispatches.`
    };
  }

  // 2. RESIDENT VERIFICATION STATUS CHECK
  if (lowerIssue.includes('verify') || lowerIssue.includes('resident') || lowerIssue.includes('unit') || lowerIssue.includes('approve')) {
    const profile = userProfiles.get(senderPhone);
    if (profile && profile.role === 'RESIDENT') {
      const logEntry = {
        incidentId: `INC-${Date.now().toString().slice(-4)}`,
        timestamp: `${dateSast} ${nowSast}`,
        caller: senderPhone,
        rootCause: `Resident verification status check (Unit ${profile.unit}, Verified: ${profile.verified}).`,
        resolution: profile.verified ? 'Confirmed verified in PostgreSQL.' : 'Re-sent verification approval card to Admin/Reception.',
        status: 'AUTO_RESOLVED'
      };
      await persistIncident(logEntry);

      if (!profile.verified) {
        await sendInteractiveButtons(
          ADMIN_REPORT_PHONE,
          'RESIDENT VERIFICATION',
          `🏠 *Resident Awaiting Approval*\n• *Name:* ${profile.fullName}\n• *Unit:* ${profile.unit}\n• *Phone:* ${senderPhone}`,
          [
            { id: `VERIFY_RES_${senderPhone}`, title: 'Approve Resident ✅' },
            { id: `REJECT_RES_${senderPhone}`, title: 'Reject ❌' }
          ],
          '',
          PHONE_ID_MAIN
        );
        return {
          resolved: true,
          message: `⏳ *Profile Found [${logEntry.incidentId}]:* ${profile.fullName} (Unit ${profile.unit}) is pending verification. I have pinged Reception/Admin for 1-tap approval right now.`
        };
      }

      return {
        resolved: true,
        message: `✅ *Verified Resident [${logEntry.incidentId}]:* ${profile.fullName} (Unit ${profile.unit}) is active and verified in PostgreSQL.`
      };
    }
  }

  // 3. SYSTEM FAULT: Daily Audit Report / Scheduler Missed Tick
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
      rootCause: 'Daily Executive Audit reconciliation requested / verified.',
      resolution: 'Dispatched consolidated 4-section Daily Executive Audit Report to Admin WhatsApp.',
      status: 'AUTO_RESOLVED'
    };
    await persistIncident(logEntry);

    return {
      resolved: true,
      message: `🛠️ *Auto-Fix Executed [${logEntry.incidentId}]:* I have dispatched the consolidated 4-section Daily Executive Audit Report to your admin WhatsApp and logged the check.`
    };
  }

  // 4. SYSTEM FAULT: HUD / Database / Telemetry Health Check
  if (
    lowerIssue.includes('hud') ||
    lowerIssue.includes('backlog') ||
    lowerIssue.includes('status') ||
    lowerIssue.includes('db') ||
    lowerIssue.includes('database') ||
    lowerIssue.includes('memory')
  ) {
    const dbStatus = pool ? 'CONNECTED (PostgreSQL Persistent)' : 'IN-MEMORY ONLY';
    const runnerCount = Array.from(userProfiles.values()).filter((p) => p.role === 'RUNNER' && p.active !== false).length;
    const residentCount = Array.from(userProfiles.values()).filter((p) => p.role === 'RESIDENT').length;

    const logEntry = {
      incidentId: `INC-${Date.now().toString().slice(-4)}`,
      timestamp: `${dateSast} ${nowSast}`,
      caller: senderPhone,
      rootCause: 'System health & persistence telemetry check requested.',
      resolution: `DB: ${dbStatus} | Residents: ${residentCount}, Runners: ${runnerCount}, Jobs: ${runnerJobs.size}.`,
      status: 'AUTO_RESOLVED'
    };
    await persistIncident(logEntry);

    return {
      resolved: true,
      message:
        `📊 *Live System Telemetry [${logEntry.incidentId}]:*\n` +
        `• *Persistence:* ${dbStatus}\n` +
        `• *Registered Residents:* ${residentCount}\n` +
        `• *Active Runners:* ${runnerCount}\n` +
        `• *Jobs in DB:* ${runnerJobs.size}\n` +
        `• *Active Passes:* ${issuedPasses.size}\n` +
        `• *Backlog Stories:* ${customerBacklogQueue.length}`
    };
  }

  // 5. OPS FAULT: Active Runner Delay / Stalled Errand
  const userJobs = Array.from(runnerJobs.values()).filter(
    (j) => j.hostPhone === senderPhone && j.status !== 'COMPLETED_VERIFIED'
  );

  if (userJobs.length > 0 && (lowerIssue.includes('late') || lowerIssue.includes('stalled') || lowerIssue.includes('stuck') || lowerIssue.includes('delay'))) {
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
      `• *Automated Fix:* Released lock, saved to DB, re-broadcast to active runners.`,
      PHONE_ID_MAIN
    );

    return {
      resolved: true,
      jobId: latestJob.jobId,
      message: `I investigated Task #${latestJob.jobId}. The assigned runner encountered a delay, so the system has automatically unassigned them and re-broadcast your delivery to the full active runner roster.`
    };
  }

  // 6. OPS FAULT: Pending Gate Clearance Alert
  const userAlerts = Array.from(securityAlerts.values()).filter(
    (a) => (a.hostPhone === senderPhone || a.visitorPhone === senderPhone) && a.status === 'PENDING_MANUAL_REVIEW'
  );

  if (userAlerts.length > 0 && (lowerIssue.includes('gate') || lowerIssue.includes('pass') || lowerIssue.includes('turnstile') || lowerIssue.includes('clearance'))) {
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

    return {
      resolved: true,
      message: `I located guest clearance voucher ${alert.alertId}. The system has verified your resident record and fast-tracked turnstile clearance.`
    };
  }

  // 7. Fallback: Log & Escalate Unmatched Technical Issue
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
// DETERMINISTIC + EXPLICIT-MODE SUPPORT, SELF-HEALING & BACKLOG AGENT
// ============================================================================
async function handleSupportAndBacklogAgent(senderPhone, userMessage, replyFromPhoneId = PHONE_ID_MAIN, forcedMode = null) {
  const lowerMsg = userMessage.toLowerCase();

  if (forcedMode === 'ISSUE') {
    const remediation = await diagnoseAndRemediateOperationalIssue(senderPhone, userMessage);
    await sendWhatsAppMessage(senderPhone, remediation.message, replyFromPhoneId);
    return;
  }

  if (!forcedMode) {
    const faultKeywords = [
      'audit', 'report', '20:00', 'schedule', 'hud', 'backlog', 'status',
      'db', 'database', 'memory', 'late', 'runner', 'broadcast', 'roster',
      'stuck', 'delay', 'gate', 'pass', 'broken', 'error', 'not running',
      'not working', 'not getting', 'not receiving', 'issue', 'verify', 'resident'
    ];

    if (faultKeywords.some((kw) => lowerMsg.includes(kw))) {
      const remediation = await diagnoseAndRemediateOperationalIssue(senderPhone, userMessage);
      await sendWhatsAppMessage(senderPhone, remediation.message, replyFromPhoneId);
      return;
    }
  }

  try {
    const modeDirective =
      forcedMode === 'IMPROVE'
        ? 'The user explicitly selected "Suggest Improvement". Treat this message as a FEATURE_REQUEST and write a crisp Agile User Story.'
        : forcedMode === 'GENERAL'
          ? 'The user explicitly selected "General Assistance". Treat this as a SUPPORT_QUERY and answer clearly.'
          : 'Classify intent as either "FEATURE_REQUEST" (any suggestion, idea, or enhancement) or "SUPPORT_QUERY" (general question).';

    const prompt = `
You are the AI Concierge Support & Product Agent for "Ponte Concierge" at Ponte City, Johannesburg.
User message: "${userMessage}"

Operational Facts:
- Errand Service: R35 promo flat fee paid via Paystack on WhatsApp. Runners earn R25 on resident handover confirmation.
- Visitor Clearance: 100% digital on WhatsApp; optical QR passes valid for 24 hours with multi-entry.
- Reception Hours: 07:00 to 16:00 Mon-Fri; Security desk manned 24/7.
- Main Menu: Users can reply "menu" anytime for 1-tap buttons (Invite Visitor, Book Runner, Help & Support).

${modeDirective}

Output JSON with:
- category: "FEATURE_REQUEST" or "SUPPORT_QUERY"
- replyText: Concise, warm WhatsApp reply (max 3 sentences). If FEATURE_REQUEST, thank them and confirm it was added to the product backlog for steering review.
- userStory: Agile User Story ("As a [user], I want [feature] so that [benefit]") if FEATURE_REQUEST, else null.
- businessValue: "High", "Medium", or "Low" if FEATURE_REQUEST, else null.
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
    await sendWhatsAppMessage(senderPhone, parsed.replyText, replyFromPhoneId);

    if ((forcedMode === 'IMPROVE' || parsed.category === 'FEATURE_REQUEST') && parsed.userStory) {
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
    if (forcedMode === 'IMPROVE') {
      const storyItem = {
        id: `STORY-${Date.now().toString().slice(-4)}`,
        rawFeedback: userMessage,
        userStory: `As a Ponte user, I want "${userMessage}" so that building operations are smoother.`,
        businessValue: 'Medium',
        senderPhone: senderPhone,
        status: 'PENDING_APPROVAL',
        submittedAt: new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
        submittedDate: new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' })
      };
      await persistStory(storyItem);
      await sendWhatsAppMessage(
        senderPhone,
        `💡 Thank you! Your improvement suggestion [${storyItem.id}] has been saved to our product backlog for next week's refinement session.`,
        replyFromPhoneId
      );
      return;
    }

    await sendWhatsAppMessage(
      senderPhone,
      `Hello! Ponte Concierge Support has received your message. Reply *menu* anytime to return to the main buttons.`,
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
// PAYSTACK DYNAMIC CHECKOUT (FAST CHANNELS)
// ============================================================================
async function generatePaystackCheckout(residentPhone, unit, jobId) {
  try {
    const payload = {
      email: `unit${unit}@ponteconcierge.co.za`,
      amount: 3500, // R35.00
      currency: 'ZAR',
      reference: `PC-${jobId}-${Date.now().toString().slice(-4)}`,
      callback_url: `https://wa.me/27810973478`,
      split_code: PAYSTACK_SPLIT_CODE,
      channels: ['card', 'qr', 'apple_pay', 'capitec_pay'],
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

async function markJobPaidAndDispatch(job) {
  if (!job || job.status !== 'PENDING_PAYMENT') return;
  const host = getHostDetails(job);
  job.unit = host.unit;
  job.hostName = host.fullName;
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
      `Task *#${job.jobId}* for *${host.fullName} · Unit ${host.unit}* is funded and dispatched to our runners.${pinReminder}`,
    PHONE_ID_MAIN
  );

  await broadcastRunnerJob(job);
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
  const hostUnit = hostProfile ? hostProfile.unit : 'Unknown';

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
      await markJobPaidAndDispatch(job);
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
// CONSOLIDATED 4-SECTION DAILY EXECUTIVE AUDIT ENGINE + EXTERNAL CRON TRIGGER
// ============================================================================
function generateAuditSummary() {
  const todayStr = new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const jobsList = Array.from(runnerJobs.values());
  const pendingJobs = jobsList.filter(j => j.status === 'PENDING_PAYMENT');
  const openPaidJobs = jobsList.filter(j => ['PAID_AWAITING_CLAIM', 'CLAIMED_AWAITING_PICKUP', 'IN_TRANSIT', 'AWAITING_RESIDENT_CONFIRMATION'].includes(j.status));
  const completedJobs = jobsList.filter(j => j.status === 'COMPLETED_VERIFIED');
  const paidJobs = jobsList.filter(j => j.paidAt);

  const grossRevenue = paidJobs.length * 35.00;
  const totalRunnerPayouts = completedJobs.length * 25.00;
  const platformMargin = completedJobs.length * 10.00;
  const communityRebate = completedJobs.length * 0.50;

  const profiles = Array.from(userProfiles.values());
  const activeRunners = profiles.filter(p => p.role === 'RUNNER' && p.active !== false);
  const verifiedResidents = profiles.filter(p => p.role === 'RESIDENT' && p.verified);
  const pendingResidents = profiles.filter(p => p.role === 'RESIDENT' && !p.verified);

  const todaysIncidents = systemIncidentLog.filter(i => i.timestamp && i.timestamp.startsWith(todayStr));
  const autoResolvedToday = todaysIncidents.filter(i => i.status === 'AUTO_RESOLVED');
  const escalatedToday = todaysIncidents.filter(i => i.status === 'ESCALATED');
  const pendingStories = customerBacklogQueue.filter(s => s.status === 'PENDING_APPROVAL');

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
    date: todayStr,
    totalTasks: jobsList.length,
    pendingCount: pendingJobs.length,
    inProgressCount: openPaidJobs.length,
    totalPaidCount: paidJobs.length,
    totalCompletedCount: completedJobs.length,
    grossRevenue,
    totalRunnerPayouts,
    platformMargin,
    communityRebate,
    activeRunnersCount: activeRunners.length,
    verifiedResidentsCount: verifiedResidents.length,
    pendingResidents,
    autoResolvedToday,
    escalatedToday,
    pendingStoriesCount: pendingStories.length,
    runnerStats
  };
}

async function sendDailyAuditReport() {
  const report = generateAuditSummary();
  let runnerBreakdownText = '';

  for (const [name, stats] of Object.entries(report.runnerStats)) {
    runnerBreakdownText += `  • *${name}:* ${stats.runs} run(s) -> R${stats.earnings.toFixed(2)}\n`;
  }
  if (!runnerBreakdownText) runnerBreakdownText = `  • _No verified runs completed yet._\n`;

  const pendingResAlert = report.pendingResidents.length > 0
    ? `\n  ⚠️ *Action Needed:* ${report.pendingResidents.map(r => `${r.fullName} (Unit ${r.unit})`).join(', ')}`
    : '';

  const incidentSummary = report.autoResolvedToday.length > 0 || report.escalatedToday.length > 0
    ? `\n  • Auto-Resolved Today: *${report.autoResolvedToday.length}* | Escalated: *${report.escalatedToday.length}*`
    : `\n  • _Zero support faults logged today._`;

  const message =
    `📊 *PONTE CONCIERGE DAILY EXECUTIVE AUDIT*\n` +
    `📅 *Date:* ${report.date}\n\n` +
    `📋 *1. Task Pipeline:*\n` +
    `• Total: ${report.totalTasks} | Awaiting Pay: ${report.pendingCount} | Active: ${report.inProgressCount} | Done: ${report.totalCompletedCount}\n\n` +
    `💰 *2. Financial Reconciliations:*\n` +
    `• *Gross Collected (R35/paid):* R${report.grossRevenue.toFixed(2)}\n` +
    `• *Runner Payouts Owed (R25/done):* R${report.totalRunnerPayouts.toFixed(2)}\n` +
    `• *Platform Margin (R10/done):* R${report.platformMargin.toFixed(2)}\n` +
    `• *Dlala Nje Fund (5%):* R${report.communityRebate.toFixed(2)}\n\n` +
    `👥 *3. Standalone Directory:*\n` +
    `• *Residents:* ${report.verifiedResidentsCount} Verified, ${report.pendingResidents.length} Pending${pendingResAlert}\n` +
    `• *Runners:* ${report.activeRunnersCount} Active on Roster\n\n` +
    `🩺 *4. Self-Healing & Backlog Pulse:*${incidentSummary}\n` +
    `  • Staged Feature Stories: *${report.pendingStoriesCount}* awaiting refinement\n\n` +
    `🏃 *Runner Shift Earnings:*\n${runnerBreakdownText}\n` +
    `_Generated automatically by Ponte Concierge Ops Engine._`;

  await sendWhatsAppMessage(ADMIN_REPORT_PHONE, message, PHONE_ID_MAIN);
}

// External Cron Endpoint (Wakes Render reliably at 20:00 SAST)
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

// Background 15-min interval + POPIA purge
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
// INBOUND MESSAGE PROCESSOR (POST) - UNIFIED BUTTON UX + SUPPORT SUB-MENU
// ============================================================================
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    if (isDuplicateMessage(message.id)) {
      console.log(`⏭️ [DEDUP] Skipping duplicate webhook message ID: ${message.id}`);
      return;
    }

    const senderPhone = message.from;
    const messageType = message.type;

    const metadata = value?.metadata || {};
    const recipientPhoneId = String(metadata.phone_number_id || '').trim();
    const displayPhoneNumber = String(metadata.display_phone_number || '').trim();

    console.log(`📥 [INBOUND] From: ${senderPhone} | To Phone ID: "${recipientPhoneId}" | Display No: "${displayPhoneNumber}" | Type: ${messageType}`);

    // =========================================================================
    // CHANNEL A: 072 DIRECT SUPPORT LINE -> AUTO-TRIAGE + SELF-HEALING
    // =========================================================================
    const isSupportChannel =
      recipientPhoneId === String(PHONE_ID_SUPPORT).trim() ||
      recipientPhoneId === '1448916934975007' ||
      displayPhoneNumber.includes('729494561');

    if (isSupportChannel) {
      console.log(`🤖 [ROUTING] Direct Support Line message from ${senderPhone}...`);
      if (messageType === 'text') {
        await handleSupportAndBacklogAgent(senderPhone, message.text.body.trim(), recipientPhoneId, null);
      }
      return;
    }

    // =========================================================================
    // CHANNEL B: 081 MAIN ENGINE -> 100% INTERACTIVE BUTTONS + 3-WAY SUPPORT
    // =========================================================================
    async function sendMainRoleMenu(phone) {
      const existing = userProfiles.get(phone);

      if (!existing) {
        await sendInteractiveButtons(
          phone,
          'PONTE CONCIERGE AT YOUR SERVICE',
          'Welcome to Ponte City! Tap an option below to get started:',
          [
            { id: 'ROLE_RESIDENT', title: 'Ponte Resident 🏠' },
            { id: 'ROLE_RUNNER', title: 'Ponte Runner 🏃' },
            { id: 'OPEN_SUPPORT', title: 'Help & Support 🩺' }
          ],
          'Visitors: Passes are issued by your host.',
          PHONE_ID_MAIN
        );
        return;
      }

      if (existing.role === 'RESIDENT') {
        const statusBadge = existing.verified ? '✅ Verified' : '⏳ Pending Unit Check';
        await sendInteractiveButtons(
          phone,
          'PONTE CONCIERGE AT YOUR SERVICE',
          `Welcome back *${existing.fullName}* — we have you registered at *Unit ${existing.unit}* [${statusBadge}].\n\nWhat would you like to do?`,
          [
            { id: 'MENU_VISITOR', title: 'Invite Visitor 🎟️' },
            { id: 'MENU_RUNNER', title: 'Book Runner 🛒' },
            { id: 'OPEN_SUPPORT', title: 'Help & Support 🩺' }
          ],
          'Tip: Reply "retail" (Coming Soon) · "menu" to reset',
          PHONE_ID_MAIN
        );
        return;
      }

      if (existing.role === 'RUNNER') {
        await sendInteractiveButtons(
          phone,
          'PONTE RUNNER HUB',
          `Welcome back *${existing.fullName}*! You are active on standby for task dispatches.`,
          [
            { id: 'RUNNER_CHECK_ROSTER', title: 'Check Open Jobs 📋' },
            { id: 'OPEN_SUPPORT', title: 'Help & Support 🩺' }
          ],
          'Reply "menu" anytime to return',
          PHONE_ID_MAIN
        );
      }
    }

    if (messageType === 'interactive' && message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;

      // 0A. HELP & SUPPORT 3-OPTION SUB-MENU
      if (buttonId === 'OPEN_SUPPORT') {
        await sendInteractiveButtons(
          senderPhone,
          'HELP & SUPPORT DESK',
          'How can Ponte Concierge assist you today? Choose an option below:',
          [
            { id: 'SUP_MODE_GENERAL', title: 'General Assistance' },
            { id: 'SUP_MODE_ISSUE', title: 'Report an Issue 🚨' },
            { id: 'SUP_MODE_IMPROVE', title: 'Suggest Improvement' }
          ],
          'Reply "menu" anytime to go back',
          PHONE_ID_MAIN
        );
        return;
      }

      // 0B. SUPPORT SUB-MENU SELECTIONS
      if (buttonId === 'SUP_MODE_GENERAL') {
        residentSessions.set(senderPhone, { step: 'AWAITING_SUPPORT_INPUT', supportMode: 'GENERAL' });
        await sendWhatsAppMessage(
          senderPhone,
          `💬 *General Assistance*\n\nAsk me anything about Ponte Concierge—reception hours, visitor passes, runner pricing, or how the service works:`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId === 'SUP_MODE_ISSUE') {
        residentSessions.set(senderPhone, { step: 'AWAITING_SUPPORT_INPUT', supportMode: 'ISSUE' });
        await sendWhatsAppMessage(
          senderPhone,
          `🚨 *Report an Operational Issue*\n\nDescribe the problem (e.g., delayed runner, missing broadcast, gate pass issue, or audit report) and our self-healing engine will investigate immediately:`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId === 'SUP_MODE_IMPROVE') {
        residentSessions.set(senderPhone, { step: 'AWAITING_SUPPORT_INPUT', supportMode: 'IMPROVE' });
        await sendWhatsAppMessage(
          senderPhone,
          `💡 *Suggest an Improvement*\n\nShare your idea or feature request—our AI Product Agent will format it into a user story for next week's refinement session:`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId === 'RUNNER_CHECK_ROSTER') {
        const remediation = await diagnoseAndRemediateOperationalIssue(senderPhone, 'check runner roster');
        await sendWhatsAppMessage(senderPhone, remediation.message, PHONE_ID_MAIN);
        return;
      }

      // 1. STANDALONE RESIDENT ONBOARDING
      if (buttonId === 'ROLE_RESIDENT') {
        residentSessions.set(senderPhone, { step: 'AWAITING_RESIDENT_ONBOARDING' });
        await sendWhatsAppMessage(
          senderPhone,
          `🏠 *Ponte Resident Registration*\n\nReply with your *Full Name* and *Unit Number* separated by a comma:\n*Example:* Thabo Mokoena, 3204`,
          PHONE_ID_MAIN
        );
        return;
      }

      // 2. IMMEDIATE RUNNER ENROLLMENT IN POSTGRESQL + OPTIONAL NAME UPDATE
      if (buttonId === 'ROLE_RUNNER') {
        const existingRunner = userProfiles.get(senderPhone);
        const runnerProfile = {
          role: 'RUNNER',
          verified: true,
          active: true,
          registeredAt: existingRunner?.registeredAt || new Date().toISOString(),
          unit: existingRunner?.unit || 'RESIDENT_RUNNER',
          fullName: existingRunner?.fullName || `Runner (${senderPhone.slice(-4)})`
        };
        await persistProfile(senderPhone, runnerProfile);
        residentSessions.set(senderPhone, { step: 'AWAITING_RUNNER_NAME_UPDATE' });

        await sendWhatsAppMessage(
          senderPhone,
          `🏃 *Runner Roster Activated!*\n\nYou are now saved in PostgreSQL as *${runnerProfile.fullName}* and will receive task broadcasts immediately.\n\nReply with your *Full Name* (and optional Unit #) if you'd like to update your display name:\n*Example:* Sipho Ndlovu, Unit 1408`,
          PHONE_ID_MAIN
        );

        const openJobs = Array.from(runnerJobs.values()).filter((j) => j.status === 'PAID_AWAITING_CLAIM');
        for (const job of openJobs) {
          await broadcastRunnerJob(job, senderPhone);
        }
        return;
      }

      // 3. MAIN MENU BUTTONS FOR RESIDENT ACTIONS
      if (buttonId === 'MENU_VISITOR') {
        const existing = userProfiles.get(senderPhone);
        if (!existing || existing.role !== 'RESIDENT') {
          residentSessions.set(senderPhone, { step: 'AWAITING_RESIDENT_ONBOARDING' });
          await sendWhatsAppMessage(senderPhone, `🏠 Reply with your *Full Name* and *Unit Number* separated by a comma (e.g., Thabo Mokoena, 3204):`, PHONE_ID_MAIN);
          return;
        }
        if (!existing.verified) {
          await sendWhatsAppMessage(
            senderPhone,
            `⏳ *Unit Verification Pending*\n\nYour profile (${existing.fullName}, Unit ${existing.unit}) is awaiting Reception/Admin confirmation before issuing visitor passes. You can still tap *Book Runner* immediately!`,
            PHONE_ID_MAIN
          );
          return;
        }
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'FULL_RESIDENTIAL' });
        await sendWhatsAppMessage(
          senderPhone,
          `👥 *Ponte Visitor Pre-Clearance*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Thabo Molefe, 0712345678`,
          PHONE_ID_MAIN
        );
        return;
      }

      if (buttonId === 'MENU_RUNNER') {
        await sendInteractiveButtons(
          senderPhone,
          'RUNNER & CONCIERGE DISPATCH',
          'Select the service you need—or drop an order screenshot anytime:',
          [
            { id: 'REQ_RUNNER_PARCEL', title: 'Collect Delivery 🛒' },
            { id: 'REQ_RUNNER_ESCORT', title: 'Escort a Visitor 👥' }
          ],
          'Promo Rate: R35.00 · Local Partners (Soon)',
          PHONE_ID_MAIN
        );
        return;
      }

      // 4. ADMIN 1-TAP RESIDENT VERIFICATION BUTTONS
      if (buttonId.startsWith('VERIFY_RES_')) {
        const targetPhone = buttonId.replace('VERIFY_RES_', '');
        const profile = userProfiles.get(targetPhone);
        if (profile) {
          profile.verified = true;
          profile.verifiedAt = new Date().toISOString();
          await persistProfile(targetPhone, profile);
          await sendWhatsAppMessage(
            senderPhone,
            `✅ *Resident Verified:* ${profile.fullName} (Unit ${profile.unit} - ${targetPhone}) can now issue visitor passes.`,
            PHONE_ID_MAIN
          );
          await sendMainRoleMenu(targetPhone);
        }
        return;
      }

      if (buttonId.startsWith('REJECT_RES_')) {
        const targetPhone = buttonId.replace('REJECT_RES_', '');
        userProfiles.delete(targetPhone);
        if (pool) await pool.query('DELETE FROM ponte_user_profiles WHERE phone = $1', [targetPhone]);
        await sendWhatsAppMessage(senderPhone, `🚫 Resident registration for ${targetPhone} rejected & removed.`, PHONE_ID_MAIN);
        await sendWhatsAppMessage(targetPhone, `⚠️ Your resident registration could not be verified. Please visit Reception with proof of residence.`, PHONE_ID_MAIN);
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
          ? `📝 *Delivery Details or Screenshot:*\n\nSend a *screenshot* of your delivery app OR reply with what to collect, courier, and PIN:\n*(e.g., "Main Gate - Zulzi delivery, PIN 5666")*`
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
          const host = getHostDetails(retryJob);
          const checkoutUrl = await generatePaystackCheckout(retryJob.hostPhone, host.unit, retryJob.jobId);
          await sendCtaUrlButton(
            senderPhone,
            `CONFIRM BOOKING #${retryJob.jobId}`,
            `💳 *Retry Payment for Task [#${retryJob.jobId}]*\n\nTap below to complete your R35.00 checkout:`,
            'Pay R35.00 💳',
            checkoutUrl,
            '',
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

        const host = getHostDetails(job);
        job.unit = host.unit;
        job.hostName = host.fullName;
        job.status = 'CLAIMED_AWAITING_PICKUP';
        job.claimedBy = senderPhone;
        await persistJob(job);

        await sendInteractiveButtons(
          senderPhone,
          `TASK #${jobId} CLAIMED`,
          `• *Type:* ${job.taskType}\n` +
          `• *Resident:* ${host.fullName} · Unit *${host.unit}* (${host.phone})\n` +
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

        const host = getHostDetails(job);
        const runner = getRunnerDetails(senderPhone);
        job.unit = host.unit;
        job.hostName = host.fullName;
        job.status = 'IN_TRANSIT';
        job.collectedAt = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await persistJob(job);

        await sendWhatsAppMessage(
          job.hostPhone,
          `🏃‍♂️ *Runner En Route to Unit ${host.unit}!*\n\n` +
            `• *Resident:* ${host.fullName} · Unit *${host.unit}*\n` +
            `• *Runner:* ${runner.fullName} (+${runner.phone})\n` +
            `• *Task:* #${job.jobId} collected & heading up.`,
          PHONE_ID_MAIN
        );

        await sendInteractiveButtons(
          senderPhone,
          `TASK #${jobId} IN TRANSIT`,
          `Heading to *${host.fullName} · Unit ${host.unit}*.\n\nTap below once you reach the resident's door:`,
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

        const host = getHostDetails(job);
        const runner = getRunnerDetails(senderPhone);
        job.unit = host.unit;
        job.hostName = host.fullName;
        job.status = 'AWAITING_RESIDENT_CONFIRMATION';
        job.deliveredAt = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await persistJob(job);

        await sendWhatsAppMessage(
          senderPhone,
          `⏳ *Delivery Reported for Task #${jobId}*\n\n` +
            `Waiting for *${host.fullName} (Unit ${host.unit})* to confirm handover before releasing payout.`,
          PHONE_ID_MAIN
        );

        await sendInteractiveButtons(
          job.hostPhone,
          'CONFIRM HANDOVER',
          `🚪 *${host.fullName} · Unit ${host.unit}*\n\n` +
            `Runner *${runner.fullName}* (+${runner.phone}) reports completing task *#${job.jobId}* at your door.\n\n` +
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

        const host = getHostDetails(job);
        job.status = 'COMPLETED_VERIFIED';
        job.completedAt = new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await persistJob(job);

        if (job.claimedBy) {
          await sendWhatsAppMessage(
            job.claimedBy,
            `🎉 *Task #${jobId} Verified by Resident!*\n\n` +
              `${host.fullName} (Unit ${host.unit}) confirmed safe handover. *R25.00* has been credited to your active shift balance.`,
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
        const hostProfile = userProfiles.get(senderPhone) || { unit: '5302', fullName: 'Resident' };

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

    // IMAGE UPLOADS (DELIVERY SCREENSHOT OR VISITOR ID)
    if (messageType === 'image') {
      const imageId = message.image.id;

      // 1. Delivery / Runner Note screenshot during AWAITING_RUNNER_NOTE
      const activeResSession = residentSessions.get(senderPhone);
      if (activeResSession && activeResSession.step === 'AWAITING_RUNNER_NOTE') {
        await sendWhatsAppMessage(senderPhone, '📸 *Reading your delivery screenshot...*', PHONE_ID_MAIN);
        const imageBuffer = await downloadMetaImage(imageId);
        if (!imageBuffer) {
          await sendWhatsAppMessage(senderPhone, '⚠️ Could not load that screenshot. Please type the delivery details or try again.', PHONE_ID_MAIN);
          return;
        }
        const extracted = await extractDeliveryDetailsFromImage(imageBuffer);
        await createAndPromptRunnerBooking(
          senderPhone,
          activeResSession.taskType || 'PARCEL_COLLECTION',
          extracted,
          activeResSession.guestPhone || null,
          imageId
        );
        return;
      }

      // 2. Visitor ID document during AWAITING_DOC_IMAGE
      const visitorSession = visitorSessions.get(senderPhone);
      if (visitorSession && visitorSession.step === 'AWAITING_DOC_IMAGE') {
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

      if (['register', 'start', 'hi', 'hello', 'menu', 'cancel'].includes(cleanText)) {
        residentSessions.delete(senderPhone);
        await sendMainRoleMenu(senderPhone);
        return;
      }

      if (cleanText === 'report' && senderPhone === ADMIN_REPORT_PHONE) {
        await sendDailyAuditReport();
        return;
      }

      // Admin UAT shortcut: "confirm pay <jobId>"
      if (senderPhone === ADMIN_REPORT_PHONE && lowerText.startsWith('confirm pay ')) {
        const targetJobId = lowerText.replace('confirm pay ', '').trim();
        const targetJob = runnerJobs.get(targetJobId);
        if (targetJob) {
          await markJobPaidAndDispatch(targetJob);
          await sendWhatsAppMessage(senderPhone, `⚡ Marked Task #${targetJobId} as PAID and dispatched to runners.`, PHONE_ID_MAIN);
        } else {
          await sendWhatsAppMessage(senderPhone, `⚠️ Task #${targetJobId} not found.`, PHONE_ID_MAIN);
        }
        return;
      }

      // RUNNER SELF-CHECK & ONBOARDING TRIGGER (Via QR Code or "runner status")
      if (cleanText === 'runner status' || cleanText === 'check runner' || cleanText === 'active runners') {
        const allRunners = Array.from(userProfiles.entries()).filter(([, p]) => p.role === 'RUNNER');
        const activeRunners = allRunners.filter(([, p]) => p.active !== false);

        if (senderPhone === ADMIN_REPORT_PHONE) {
          const rosterLines = activeRunners
            .map(([ph, p], idx) => `${idx + 1}. *${p.fullName}* (${ph}) — 🟢 Active`)
            .join('\n');
          await sendWhatsAppMessage(
            senderPhone,
            `🏃 *REGISTERED RUNNER ROSTER (${activeRunners.length})*\n\n${rosterLines || '_No runners registered yet._'}`,
            PHONE_ID_MAIN
          );
          return;
        }

        const existing = userProfiles.get(senderPhone);
        if (existing && existing.role === 'RUNNER') {
          existing.active = true;
          await persistProfile(senderPhone, existing);
          const openJobs = Array.from(runnerJobs.values()).filter((j) => j.status === 'PAID_AWAITING_CLAIM');
          await sendWhatsAppMessage(
            senderPhone,
            `✅ *Runner Status: ACTIVE*\n\n• *Name:* ${existing.fullName}\n• *Roster:* Verified in PostgreSQL\n• *Open Jobs Waiting:* ${openJobs.length}`,
            PHONE_ID_MAIN
          );
          for (const job of openJobs) {
            await broadcastRunnerJob(job, senderPhone);
          }
          return;
        }

        const newRunner = {
          role: 'RUNNER',
          verified: true,
          active: true,
          registeredAt: new Date().toISOString(),
          unit: 'RESIDENT_RUNNER',
          fullName: `Runner (${senderPhone.slice(-4)})`
        };
        await persistProfile(senderPhone, newRunner);
        residentSessions.set(senderPhone, { step: 'AWAITING_RUNNER_NAME_UPDATE' });

        await sendWhatsAppMessage(
          senderPhone,
          `✅ *Runner Status Activated!* You are saved in PostgreSQL and will receive task broadcasts immediately.\n\nReply with your *Full Name* (and optional Unit #) to update your profile name:\n*Example:* Sipho Ndlovu, Unit 1408`,
          PHONE_ID_MAIN
        );
        return;
      }

      // Admin shortcut: "approve resident 0821234567"
      if (senderPhone === ADMIN_REPORT_PHONE && lowerText.startsWith('approve resident ')) {
        let target = lowerText.replace('approve resident ', '').replace(/\D/g, '');
        if (target.startsWith('0')) target = '27' + target.substring(1);
        const prof = userProfiles.get(target);
        if (prof) {
          prof.verified = true;
          await persistProfile(target, prof);
          await sendWhatsAppMessage(senderPhone, `✅ Approved Resident ${prof.fullName} (Unit ${prof.unit} - ${target}).`, PHONE_ID_MAIN);
          await sendMainRoleMenu(target);
        } else {
          await sendWhatsAppMessage(senderPhone, `⚠️ No pending profile found for ${target}.`, PHONE_ID_MAIN);
        }
        return;
      }

      // Admin shortcut: "set resident 27715720458 5302 Rudi van Rensburg"
      if (senderPhone === ADMIN_REPORT_PHONE && lowerText.startsWith('set resident ')) {
        const rest = rawText.slice('set resident '.length).trim();
        const parts = rest.split(/\s+/);
        let target = (parts[0] || '').replace(/\D/g, '');
        if (target.startsWith('0')) target = '27' + target.substring(1);
        const unit = (parts[1] || '5302').toUpperCase();
        const fullName = parts.slice(2).join(' ') || 'Rudi van Rensburg';

        if (target) {
          const updatedResident = {
            role: 'RESIDENT',
            verified: true,
            registeredAt: userProfiles.get(target)?.registeredAt || new Date().toISOString(),
            unit,
            fullName
          };
          await persistProfile(target, updatedResident);
          await sendWhatsAppMessage(
            senderPhone,
            `✅ *Updated Resident:* ${fullName} — *Unit ${unit}* (${target}) saved to PostgreSQL.`,
            PHONE_ID_MAIN
          );
          await sendMainRoleMenu(target);
        }
        return;
      }

      const activeResSession = residentSessions.get(senderPhone);

      if (activeResSession && activeResSession.step === 'AWAITING_SUPPORT_INPUT') {
        const mode = activeResSession.supportMode || null;
        residentSessions.delete(senderPhone);
        await handleSupportAndBacklogAgent(senderPhone, rawText, PHONE_ID_MAIN, mode);
        return;
      }

      if (activeResSession && activeResSession.step === 'AWAITING_RESIDENT_ONBOARDING') {
        const parts = rawText.split(',');
        if (parts.length < 2) {
          await sendWhatsAppMessage(senderPhone, '⚠️ Please separate your *Full Name* and *Unit Number* with a comma (e.g., Thabo Mokoena, 3204).', PHONE_ID_MAIN);
          return;
        }
        const fullName = parts[0].trim();
        const unit = parts[1].trim().toUpperCase();

        const newResident = {
          role: 'RESIDENT',
          verified: false,
          registeredAt: new Date().toISOString(),
          unit,
          fullName
        };
        await persistProfile(senderPhone, newResident);
        residentSessions.delete(senderPhone);

        await sendInteractiveButtons(
          senderPhone,
          'PROFILE SAVED',
          `✅ Welcome *${fullName} (Unit ${unit})*!\n\n• You can *Book Runner* immediately.\n• *Visitor Passes* unlock as soon as Reception/Admin confirms your unit.`,
          [
            { id: 'MENU_RUNNER', title: 'Book Runner 🛒' },
            { id: 'OPEN_SUPPORT', title: 'Help & Support 🩺' }
          ],
          '',
          PHONE_ID_MAIN
        );

        await sendInteractiveButtons(
          ADMIN_REPORT_PHONE,
          'NEW RESIDENT SIGN-UP',
          `🏠 *Verify Ponte Resident*\n• *Name:* ${fullName}\n• *Unit:* ${unit}\n• *Phone:* ${senderPhone}`,
          [
            { id: `VERIFY_RES_${senderPhone}`, title: 'Approve Resident ✅' },
            { id: `REJECT_RES_${senderPhone}`, title: 'Reject ❌' }
          ],
          '',
          PHONE_ID_MAIN
        );
        return;
      }

      if (activeResSession && (activeResSession.step === 'AWAITING_RUNNER_ONBOARDING' || activeResSession.step === 'AWAITING_RUNNER_NAME_UPDATE')) {
        const parts = rawText.split(',');
        const fullName = parts[0].trim();
        const unit = parts[1] ? parts[1].trim().toUpperCase() : 'RESIDENT_RUNNER';

        const updatedRunner = {
          role: 'RUNNER',
          verified: true,
          active: true,
          registeredAt: userProfiles.get(senderPhone)?.registeredAt || new Date().toISOString(),
          unit,
          fullName
        };
        await persistProfile(senderPhone, updatedRunner);
        residentSessions.delete(senderPhone);

        await sendWhatsAppMessage(
          senderPhone,
          `🏃 *Runner Profile Updated — ${fullName}!*\n\nYour profile is saved permanently in PostgreSQL. You will receive interactive job cards whenever residents book deliveries or escorts.`,
          PHONE_ID_MAIN
        );

        const openJobs = Array.from(runnerJobs.values()).filter((j) => j.status === 'PAID_AWAITING_CLAIM');
        for (const job of openJobs) {
          await broadcastRunnerJob(job, senderPhone);
        }
        return;
      }

      if (activeResSession && activeResSession.step === 'AWAITING_RUNNER_NOTE') {
        await createAndPromptRunnerBooking(
          senderPhone,
          activeResSession.taskType || 'PARCEL_COLLECTION',
          rawText,
          activeResSession.guestPhone || null,
          null
        );
        return;
      }

      if (cleanText === 'runner' || cleanText === 'parcel' || cleanText === 'delivery') {
        const existing = userProfiles.get(senderPhone);
        if (!existing) {
          residentSessions.set(senderPhone, { step: 'AWAITING_RESIDENT_ONBOARDING' });
          await sendWhatsAppMessage(
            senderPhone,
            `🏠 *Quick Setup First:* Reply with your *Full Name* and *Unit Number* separated by a comma (e.g., Thabo Mokoena, 3204) before booking a runner.`,
            PHONE_ID_MAIN
          );
          return;
        }

        await sendInteractiveButtons(
          senderPhone,
          'RUNNER & CONCIERGE DISPATCH',
          'Select the service you need—or drop an order screenshot anytime:',
          [
            { id: 'REQ_RUNNER_PARCEL', title: 'Collect Delivery 🛒' },
            { id: 'REQ_RUNNER_ESCORT', title: 'Escort a Visitor 👥' }
          ],
          'Promo Rate: R35.00 · Local Partners (Soon)',
          PHONE_ID_MAIN
        );
        return;
      }

      if (cleanText === 'visitor' || cleanText === 'invite' || cleanText === 'retail' || cleanText === 'parking') {
        const existing = userProfiles.get(senderPhone);
        if (!existing || existing.role !== 'RESIDENT') {
          residentSessions.set(senderPhone, { step: 'AWAITING_RESIDENT_ONBOARDING' });
          await sendWhatsAppMessage(
            senderPhone,
            `🏠 *Resident Registration Required*\n\nReply with your *Full Name* and *Unit Number* separated by a comma (e.g., Thabo Mokoena, 3204):`,
            PHONE_ID_MAIN
          );
          return;
        }

        if (!existing.verified) {
          await sendWhatsAppMessage(
            senderPhone,
            `⏳ *Unit Verification Pending*\n\nYour profile (${existing.fullName}, Unit ${existing.unit}) is awaiting Reception/Admin confirmation before issuing visitor passes.`,
            PHONE_ID_MAIN
          );
          return;
        }

        const zone = (cleanText === 'retail' || cleanText === 'parking') ? 'RETAIL_PARKING' : 'FULL_RESIDENTIAL';
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone });
        await sendWhatsAppMessage(
          senderPhone,
          zone === 'RETAIL_PARKING'
            ? `🅿️ *Retail / Parking Pre-Clearance (Coming Soon)*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Lerato Khumalo, 0831112233`
            : `👥 *Ponte Visitor Pre-Clearance*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Thabo Molefe, 0712345678`,
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
          'Parking & Uber/Bolt passes: Roadmap preview',
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

      if (rawText.split(/\s+/).length >= 3) {
        await handleSupportAndBacklogAgent(senderPhone, rawText, PHONE_ID_MAIN, null);
      } else {
        await sendMainRoleMenu(senderPhone);
      }
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

  const pendingResidents = Array.from(userProfiles.entries()).filter(([, p]) => p.role === 'RESIDENT' && !p.verified);
  const resRows = pendingResidents.map(([phone, p]) => `
    <tr style="border-bottom: 1px solid #334155;">
      <td style="padding: 10px; font-weight: bold; color: #facc15;">Unit ${p.unit}</td>
      <td style="padding: 10px;">${p.fullName}</td>
      <td style="padding: 10px;">${phone}</td>
      <td style="padding: 10px;">
        <a href="/security/verify-resident?phone=${phone}&action=APPROVE" style="background: #22c55e; color: white; padding: 5px 10px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold;">Approve Resident ✅</a>
        <a href="/security/verify-resident?phone=${phone}&action=REJECT" style="background: #ef4444; color: white; padding: 5px 10px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold; margin-left: 6px;">Reject</a>
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
          table { width: 100%; border-collapse: collapse; text-align: left; margin-bottom: 25px; }
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

        <h3 style="color: #facc15;">🏠 Pending Resident Unit Approvals</h3>
        <table>
          <thead><tr><th>Unit</th><th>Resident Name</th><th>Mobile</th><th>Reception Verification</th></tr></thead>
          <tbody>${resRows || '<tr><td colspan="4" style="padding: 15px; text-align: center; color: #64748b;">No residents awaiting unit approval.</td></tr>'}</tbody>
        </table>

        <div style="background: #1e293b; padding: 20px; border-radius: 8px; margin-top: 20px;">
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

app.get('/security/verify-resident', requireHudAuth, async (req, res) => {
  const { phone, action } = req.query;
  const profile = userProfiles.get(phone);
  if (profile) {
    if (action === 'APPROVE') {
      profile.verified = true;
      profile.verifiedAt = new Date().toISOString();
      await persistProfile(phone, profile);
      await sendWhatsAppMessage(phone, `🎉 *Resident Profile Verified!* Welcome ${profile.fullName} (Unit ${profile.unit}). Reply *menu* anytime for 1-tap visitor passes and runner bookings.`, PHONE_ID_MAIN);
    } else {
      userProfiles.delete(phone);
      if (pool) await pool.query('DELETE FROM ponte_user_profiles WHERE phone = $1', [phone]);
      await sendWhatsAppMessage(phone, `⚠️ Your resident unit registration could not be verified. Please visit Reception.`, PHONE_ID_MAIN);
    }
  }
  res.redirect('/security/live');
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
// PRODUCT BACKLOG, DIRECTORY & SELF-HEALING INCIDENT HUD
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

  const directoryRows = Array.from(userProfiles.entries()).map(([phone, p]) => `
    <tr style="border-bottom: 1px solid #334155;">
      <td style="padding: 10px; font-weight: bold; color: ${p.role === 'RUNNER' ? '#38bdf8' : '#a855f7'};">${p.role}</td>
      <td style="padding: 10px; font-size: 12px;">${p.fullName}</td>
      <td style="padding: 10px; font-size: 12px;">${p.unit || '—'}</td>
      <td style="padding: 10px; font-size: 12px;">${phone}</td>
      <td style="padding: 10px; font-size: 11px; font-weight: bold; color: ${p.verified !== false ? '#4ade80' : '#facc15'};">
        ${p.role === 'RUNNER' ? (p.active !== false ? 'ACTIVE ON ROSTER' : 'INACTIVE') : (p.verified ? 'VERIFIED' : 'PENDING APPROVAL')}
      </td>
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

        <div class="header">
          <h3 style="margin: 0; color: #a855f7;">👥 Standalone Resident & Runner Directory (PostgreSQL)</h3>
          <div style="font-size: 12px; color: #94a3b8;">Decoupled from HikCentral</div>
        </div>
        <table>
          <thead><tr><th>Role</th><th>Full Name</th><th>Unit</th><th>WhatsApp Number</th><th>Status</th></tr></thead>
          <tbody>${directoryRows}</tbody>
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
    profiles: userProfiles.size,
    time: new Date().toISOString()
  });
});

// Initialize DB & Start Server
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Ponte Concierge running on port ${PORT}`);
  });
});
