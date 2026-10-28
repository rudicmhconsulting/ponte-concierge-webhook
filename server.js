const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const VERIFY_TOKEN = 'ponte_concierge_secure_token';

// State machines
const activeJobs = new Map();
const residentSessions = new Map(); // Keyed by resident phone
const visitorRegistrations = new Map(); // Keyed by visitor phone

// =================================================================
// 1. UTILITIES & COMPLIANCE ALGORITHMS
// =================================================================

function validateSouthAfricanID(id) {
  const cleanId = id.replace(/\s+/g, '').replace(/-/g, '');
  if (!/^\d{13}$/.test(cleanId)) return false;

  const month = parseInt(cleanId.substring(2, 4), 10);
  const day = parseInt(cleanId.substring(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let digit = parseInt(cleanId.charAt(i), 10);
    if (i % 2 !== 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function maskIdNumber(id) {
  const clean = id.trim();
  if (clean.length === 13) {
    return `${clean.substring(0, 6)}*****${clean.substring(11)}`;
  }
  return clean.length > 4 ? `${clean.substring(0, 2)}***${clean.slice(-2)}` : '***';
}

function normalizePhone(phone) {
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('0') && clean.length === 10) {
    clean = '27' + clean.substring(1);
  }
  return clean;
}

// =================================================================
// 2. WEBHOOK VERIFICATION (GET /webhook)
// =================================================================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =================================================================
// 3. EVENT ROUTER & WEBHOOK LISTENER (POST /webhook)
// =================================================================

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;

          if (value && value.messages && value.messages.length > 0) {
            const message = value.messages[0];
            const senderPhone = message.from;

            // -------------------------------------------------------------
            // CASE A: INTERACTIVE BUTTON CALLBACKS
            // -------------------------------------------------------------
            if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
              const buttonId = message.interactive.button_reply.id;
              console.log(`🔘 Button from ${senderPhone}: ${buttonId}`);

              // 1. Role Selection: Resident
              if (buttonId === 'ROLE_RESIDENT') {
                residentSessions.set(senderPhone, { step: 'AWAITING_NAME_AND_CELL' });
                await sendWhatsAppMessage(
                  senderPhone,
                  '🏠 *Resident Onboarding Activated*\n\nTo pre-clear a guest, reply with their *Full Name* and *Mobile Number* separated by a comma:\n\n*Example:* Sipho Dlamini, 0821234567'
                );
                return;
              }

              // 2. Role Selection: Runner
              if (buttonId === 'ROLE_RUNNER') {
                await sendWhatsAppMessage(
                  senderPhone,
                  '🏃 *Runner Onboarding*\n\nYou are registered on the standby runner dispatch roster. When deliveries arrive at reception, you will receive interactive dispatch cards with delivery payouts.'
                );
                return;
              }

              // 3. Role Selection: Visitor Pass
              if (buttonId === 'ROLE_VISITOR') {
                await sendWhatsAppMessage(
                  senderPhone,
                  '🛡️ *Visitor Access*\n\nVisitor passes must be pre-cleared by a registered Ponte resident. Ask your host resident to text *visitor* to this number to invite you.'
                );
                return;
              }

              // 4. Runner Job Accept
              if (buttonId.startsWith('JOB_ACCEPT_')) {
                const jobId = buttonId.replace('JOB_ACCEPT_', '');
                const job = activeJobs.get(jobId);

                if (!job || job.status === 'ASSIGNED') {
                  await sendWhatsAppMessage(senderPhone, `❌ Job #${jobId} already claimed.`);
                  return;
                }

                job.status = 'ASSIGNED';
                job.runner = senderPhone;
                activeJobs.set(jobId, job);

                await sendWhatsAppMessage(
                  senderPhone,
                  `✅ *Job #${jobId} Confirmed!*\n\nPresent token *[PK-${jobId}]* at Reception for Unit ${job.unit}.\n💰 R${job.payout.toFixed(2)} logged.`
                );
                return;
              }

              // 5. Runner Job Decline
              if (buttonId.startsWith('JOB_DECLINE_')) {
                await sendWhatsAppMessage(senderPhone, `👍 Job declined. You remain on the active runner roster.`);
                return;
              }

              // 6. Resident selects arrival method for visitor
              if (buttonId.startsWith('ACCESS_TYPE_')) {
                const session = residentSessions.get(senderPhone);
                if (!session) {
                  await sendWhatsAppMessage(senderPhone, `⚠️ Session expired. Type *visitor* to restart.`);
                  return;
                }

                session.accessType = buttonId.replace('ACCESS_TYPE_', '');
                residentSessions.delete(senderPhone);

                // Initialize registration session on the VISITOR's phone
                visitorRegistrations.set(session.visitorPhone, {
                  visitorName: session.visitorName,
                  hostPhone: senderPhone,
                  accessType: session.accessType,
                  step: 'AWAITING_ID_NUMBER'
                });

                // Confirm to Resident
                await sendWhatsAppMessage(
                  senderPhone,
                  `✅ *Pre-Clearance Initiated!*\n\nAn identity verification request was sent to *${session.visitorName}* (+${session.visitorPhone}).\nTheir 24h pass will be generated once verified.`
                );

                // Dispatch Invitation to Visitor
                await sendWhatsAppMessage(
                  session.visitorPhone,
                  `👋 *Hello ${session.visitorName}!*\n\nYou have been invited to *Ponte City* by a resident.\n\n` +
                  `To issue your secure 24-hour gate pass, please reply with your *13-digit SA ID Number* or *Passport Number*:`
                );
                return;
              }
            }

            // -------------------------------------------------------------
            // CASE B: INBOUND IMAGES (DOCUMENT UPLOAD BY VISITOR)
            // -------------------------------------------------------------
            if (message.type === 'image') {
              const vReg = visitorRegistrations.get(senderPhone);
              if (vReg && vReg.step === 'AWAITING_DOC_IMAGE') {
                console.log(`📸 Document image uploaded by visitor: ${vReg.visitorName}`);

                vReg.documentMediaId = message.image.id;
                vReg.step = 'COMPLETED';

                // Issue Pass directly to the visitor
                await issueVisitorPass(senderPhone, vReg);

                // Alert the resident that their guest is cleared
                await sendWhatsAppMessage(
                  vReg.hostPhone,
                  `🔔 *Visitor Cleared!*\n\n*${vReg.visitorName}* uploaded identity verification. A 24-hour multi-entry gate pass has been delivered to their device.`
                );

                visitorRegistrations.delete(senderPhone);
                return;
              }
            }

            // -------------------------------------------------------------
            // CASE C: DIRECT INBOUND TEXT MESSAGES
            // -------------------------------------------------------------
            if (message.type === 'text') {
              const rawText = message.text.body.trim();
              const lowerText = rawText.toLowerCase();
              console.log(`💬 Inbound text from ${senderPhone}: "${rawText}"`);

              // 1. Check if sender is a VISITOR completing identity capture
              const vReg = visitorRegistrations.get(senderPhone);
              if (vReg && vReg.step === 'AWAITING_ID_NUMBER') {
                const idCandidate = rawText.replace(/\s+/g, '');

                if (/^\d+$/.test(idCandidate)) {
                  if (idCandidate.length === 13) {
                    if (!validateSouthAfricanID(idCandidate)) {
                      await sendWhatsAppMessage(
                        senderPhone,
                        `❌ *Invalid SA ID Number*\nChecksum failed. Please reply with a valid 13-digit SA ID number or foreign passport.`
                      );
                      return;
                    }
                  } else {
                    await sendWhatsAppMessage(
                      senderPhone,
                      `❌ *Invalid ID Length*\nSA ID must be 13 digits. Foreign passports must include alphanumeric prefix.`
                    );
                    return;
                  }
                }

                vReg.idNumber = idCandidate;
                vReg.step = 'AWAITING_DOC_IMAGE';
                visitorRegistrations.set(senderPhone, vReg);

                await sendWhatsAppMessage(
                  senderPhone,
                  `📸 *ID Document Required*\n\nPlease upload a photo of your *ID Card / Book, Driver's License, or Passport* to finalize your 24-hour pass.\n\n_Note: Images are cached temporarily for access control and purged per POPIA requirements._`
                );
                return;
              }

              // 2. Check if sender is a RESIDENT entering visitor name & phone
              const rSession = residentSessions.get(senderPhone);
              if (rSession && rSession.step === 'AWAITING_NAME_AND_CELL') {
                const parts = rawText.split(',');
                if (parts.length < 2) {
                  await sendWhatsAppMessage(
                    senderPhone,
                    `⚠️ *Format Error*\nPlease supply Visitor Name and Mobile Number separated by a comma.\n\n*Example:* Sipho Dlamini, 0821234567`
                  );
                  return;
                }

                const visitorName = parts[0].trim();
                const visitorPhone = normalizePhone(parts[1].trim());

                if (visitorPhone.length < 10) {
                  await sendWhatsAppMessage(
                    senderPhone,
                    `⚠️ *Invalid Mobile Number*\nPlease check the cell number provided.`
                  );
                  return;
                }

                rSession.visitorName = visitorName;
                rSession.visitorPhone = visitorPhone;
                rSession.step = 'AWAITING_ACCESS_TYPE';
                residentSessions.set(senderPhone, rSession);

                await sendAccessTypeButtons(senderPhone, visitorName);
                return;
              }

              //
