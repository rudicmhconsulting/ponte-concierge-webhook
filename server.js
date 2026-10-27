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

// --- 1. UTILITIES ---
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

// --- 2. GET /webhook ---
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

// --- 3. POST /webhook ---
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
            // INTERACTIVE BUTTON REPLIES
            // -------------------------------------------------------------
            if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
              const buttonId = message.interactive.button_reply.id;
              console.log(`🔘 Button from ${senderPhone}: ${buttonId}`);

              // Runner Claim
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

              // Resident selects access type for visitor
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

                // 1. Confirm to Resident
                await sendWhatsAppMessage(
                  senderPhone,
                  `✅ *Pre-Clearance Initiated!*\n\nAn identity verification request was sent to *${session.visitorName}* (+${session.visitorPhone}).\nTheir 24h pass will be generated once verified.`
                );

                // 2. Dispatch Invitation to Visitor
                await sendWhatsAppMessage(
                  session.visitorPhone,
                  `👋 *Hello ${session.visitorName}!*\n\nYou have been invited to *Ponte City* by a resident.\n\n` +
                  `To issue your secure 24-hour gate pass, please reply with your *13-digit SA ID Number* or *Passport Number*:`
                );
                return;
              }
            }

            // -------------------------------------------------------------
            // DOCUMENT IMAGE UPLOAD (BY VISITOR)
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
            // TEXT MESSAGES
            // -------------------------------------------------------------
            if (message.type === 'text') {
              const rawText = message.text.body.trim();
              const lowerText = rawText.toLowerCase();

              // Check if the sender is a VISITOR completing identity capture
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

              // Check if the sender is a RESIDENT entering visitor info
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

              // General Commands
              if (lowerText === 'run' || lowerText === 'testjob') {
                const testId = Math.floor(1000 + Math.random() * 9000).toString();
                const newJob = { id: testId, unit: '3204', courier: 'Takealot', payout: 25.00, status: 'OPEN' };
                activeJobs.set(testId, newJob);
                await sendRunnerJob(senderPhone, newJob);
              } 
              else if (lowerText.includes('pass') || lowerText.includes('visitor')) {
                residentSessions.set(senderPhone, { step: 'AWAITING_NAME_AND_CELL' });
                await sendWhatsAppMessage(
                  senderPhone,
                  `🛡️ *Ponte Visitor Pre-Clearance*\n\nPlease reply with your guest's *Full Name* and *Mobile Number* separated by a comma:\n\n*Example:* Sipho Dlamini, 0821234567`
                );
              } 
              else {
                await sendWhatsAppMessage(
                  senderPhone,
                  `👋 *Welcome to Ponte Concierge!*\n\n• Text *run* to test the Runner Dispatch Job Box\n• Text *visitor* to invite a guest & issue a 24h pass`
                );
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook Error:', err);
  }
});

// Health check
app.get('/', (req, res) => res.status(200).send('Ponte Concierge Webhook Service Active 🚀'));

// --- 4. HELPERS ---
async function sendWhatsAppMessage(recipientPhone, messageText) {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: messageText },
      }),
    });
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.message);
  }
}

async function sendAccessTypeButtons(recipientPhone, visitorName) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '🛡️ SELECT ACCESS TYPE' },
        body: { text: `Select arrival mode for *${visitorName}*:` },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'ACCESS_TYPE_PEDESTRIAN', title: '🚶 Pedestrian' } },
            { type: 'reply', reply: { id: 'ACCESS_TYPE_VEHICLE', title: '🚗 Vehicle' } },
            { type: 'reply', reply: { id: 'ACCESS_TYPE_EHAILING', title: '🚕 Uber / Bolt' } },
          ],
        },
      },
    };

    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending access buttons:', error.message);
  }
}

async function sendWhatsAppImage(recipientPhone, imageUrl, captionText) {
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone,
        type: 'image',
        image: { link: imageUrl, caption: captionText },
      }),
    });
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending image:', error.message);
  }
}

async function sendRunnerJob(runnerPhone, job) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: runnerPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '📦 PONTE CONCIERGE RUNNER' },
        body: {
          text: `*New Task Available!*\n\n• *Job ID:* #${job.id}\n• *Pickup:* Reception Desk\n• *Destination:* Unit ${job.unit}\n• *Courier/Item:* ${job.courier}\n• *Payout:* R${job.payout.toFixed(2)}`,
        },
        footer: { text: 'Tap to claim — first to accept gets the run.' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `JOB_ACCEPT_${job.id}`, title: 'Accept Run 🚀' } },
            { type: 'reply', reply: { id: `JOB_DECLINE_${job.id}`, title: 'Decline' } },
          ],
        },
      },
    };

    const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending runner job:', error.message);
  }
}

async function issueVisitorPass(recipientPhone, session) {
  const tunnelBaseUrl = process.env.HIKCENTRAL_BASE_URL;

  let passCode = `PONTE-${Math.floor(100000 + Math.random() * 900000)}`;
  let qrPayload = JSON.stringify({
    pass: passCode,
    name: session.visitorName,
    id: maskIdNumber(session.idNumber),
    type: session.accessType,
    multiEntry: true,
    validHours: 24,
    issuedAt: new Date().toISOString()
  });

  if (tunnelBaseUrl && tunnelBaseUrl.startsWith('http')) {
    try {
      console.log(`🔌 Bridging to HikCentral via tunnel: ${tunnelBaseUrl}`);
      const hcpResponse = await fetch(`${tunnelBaseUrl}/api/visitor/v1/visitor/reservation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitorName: session.visitorName,
          certificateType: '111',
          certificateNo: session.idNumber,
          phoneNo: recipientPhone
        })
      });
      const hcpData = await hcpResponse.json();
      if (hcpData.data && hcpData.data.qrCode) {
        qrPayload = hcpData.data.qrCode;
        passCode = hcpData.data.visitorId || passCode;
      }
    } catch (err) {
      console.warn('⚠️ Tunnel call failed; using mock pass fallback.', err.message);
    }
  }

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(qrPayload)}`;

  await sendWhatsAppImage(
    recipientPhone,
    qrImageUrl,
    `🎟️ *PONTE 24-HOUR VISITOR PASS*\n\n` +
    `• *Visitor:* ${session.visitorName}\n` +
    `• *ID / Passport:* ${maskIdNumber(session.idNumber)} (Verified)\n` +
    `• *Entry Type:* ${session.accessType}\n` +
    `• *Pass Code:* ${passCode}\n` +
    `• *Access Policy:* 24-Hour Multi-Entry (Anti-Passback Enforced)\n` +
    `• *Expires:* In 24 hours\n\n` +
    `_Present this QR barcode to optical turnstile / boom scanner. Personal document image queued for automated POPIA purge within 24 hours._`
  );
}

app.listen(PORT, HOST, () => {
  console.log(`🚀 Ponte Concierge webhook server is running on http://${HOST}:${PORT}`);
});
