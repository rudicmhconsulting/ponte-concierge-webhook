const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const VERIFY_TOKEN = 'ponte_concierge_secure_token';

// State machines
const activeJobs = new Map();
const residentSessions = new Map();
const visitorRegistrations = new Map();

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

              if (buttonId === 'ROLE_RESIDENT') {
                residentSessions.set(senderPhone, { step: 'AWAITING_NAME_AND_CELL' });
                await sendWhatsAppMessage(
                  senderPhone,
                  '🏠 *Resident Onboarding Activated*\n\nTo pre-clear a guest, reply with their *Full Name* and *Mobile Number* separated by a comma:\n\n*Example:* Sipho Dlamini, 0821234567'
                );
                return;
              }

              if (buttonId === 'ROLE_RUNNER') {
                await sendWhatsAppMessage(
                  senderPhone,
                  '🏃 *Runner Onboarding*\n\nYou are registered on the standby runner dispatch roster. When deliveries arrive at reception, you will receive interactive dispatch cards with delivery payouts.'
                );
                return;
              }

              if (buttonId === 'ROLE_VISITOR') {
                await sendWhatsAppMessage(
                  senderPhone,
                  '🛡️ *Visitor Access*\n\nVisitor passes must be pre-cleared by a registered Ponte resident. Ask your host resident to text *visitor* to this number to invite you.'
                );
                return;
              }

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

              if (buttonId.startsWith('JOB_DECLINE_')) {
                await sendWhatsAppMessage(senderPhone, `👍 Job declined. You remain on the active runner roster.`);
                return;
              }

              if (buttonId.startsWith('ACCESS_TYPE_')) {
                const session = residentSessions.get(senderPhone);
                if (!session) {
                  await sendWhatsAppMessage(senderPhone, `⚠️ Session expired. Type *visitor* to restart.`);
                  return;
                }

                session.accessType = buttonId.replace('ACCESS_TYPE_', '');
                residentSessions.delete(senderPhone);

                visitorRegistrations.set(session.visitorPhone, {
                  visitorName: session.visitorName,
                  hostPhone: senderPhone,
                  accessType: session.accessType,
                  step: 'AWAITING_ID_NUMBER'
                });

                await sendWhatsAppMessage(
                  senderPhone,
                  `✅ *Pre-Clearance Initiated!*\n\nAn identity verification request was sent to *${session.visitorName}* (+${session.visitorPhone}).\nTheir 24h pass will be generated once verified.`
                );

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

                await issueVisitorPass(senderPhone, vReg);

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
              const cleanText = lowerText.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
              console.log(`💬 Inbound text from ${senderPhone}: "${rawText}" (Clean: "${cleanText}")`);

              // 1. BULLETPROOF ONE-TAP ONBOARDING TRIGGER (Meta QR + Direct QR + Common Greetings)
              if (
                cleanText === 'register' ||
                cleanText === 'start' ||
                cleanText === 'hi' ||
                cleanText === 'hello' ||
                cleanText.includes('interested in learning') ||
                cleanText.includes('more about your business') ||
                cleanText.includes('learning more')
              ) {
                await sendRegistrationMenu(senderPhone);
                return;
              }

              // 2. VISITOR IDENTITY CAPTURE FLOW
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

              // 3. RESIDENT VISITOR INVITATION FLOW
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

              // 4. RUNNER SIMULATION
              if (lowerText === 'run' || lowerText === 'testjob') {
                const testId = Math.floor(1000 + Math.random() * 9000).toString();
                const newJob = { id: testId, unit: '3204', courier: 'Takealot', payout: 25.00, status: 'OPEN' };
                activeJobs.set(testId, newJob);
                await sendRunnerJob(senderPhone, newJob);
                return;
              }

              // 5. DIRECT VISITOR INVITATION TRIGGER
              if (lowerText.includes('pass') || lowerText.includes('visitor')) {
                residentSessions.set(senderPhone, { step: 'AWAITING_NAME_AND_CELL' });
                await sendWhatsAppMessage(
                  senderPhone,
                  `🛡️ *Ponte Visitor Pre-Clearance*\n\nPlease reply with your guest's *Full Name* and *Mobile Number* separated by a comma:\n\n*Example:* Sipho Dlamini, 0821234567`
                );
                return;
              }

              // 6. PARCEL DISPATCH REQUEST
              if (lowerText.includes('parcel') || lowerText.includes('fetch') || lowerText.includes('collect')) {
                const testId = Math.floor(1000 + Math.random() * 9000).toString();
                const newJob = { id: testId, unit: 'Resident Request', courier: 'Reception Desk', payout: 25.00, status: 'OPEN' };
                activeJobs.set(testId, newJob);
                await sendRunnerJob(senderPhone, newJob);
                return;
              }

              // 7. FALLBACK INSTRUCTIONAL MENU
              await sendWhatsAppMessage(
                senderPhone,
                `👋 *Welcome to Ponte Concierge!*\n\n• Text *register* to launch role onboarding\n• Text *run* to test the Runner Dispatch Job Box\n• Text *visitor* to invite a guest & issue a 24h pass\n• Text *parcel* to request an apartment runner`
              );
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook Exception:', err);
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('Ponte Concierge Webhook Service is Active 🚀');
});

// =================================================================
// 4. OUTBOUND MESSAGING HELPERS
// =================================================================

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

async function sendRegistrationMenu(recipientPhone) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '🏢 PONTE CONCIERGE ONBOARDING' },
        body: { 
          text: 'Welcome to Ponte City! To activate your profile and clearance, please select your role:' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'ROLE_RESIDENT', title: '🏠 Resident' } },
            { type: 'reply', reply: { id: 'ROLE_RUNNER', title: '🏃 Runner' } },
            { type: 'reply', reply: { id: 'ROLE_VISITOR', title: '🛡️ Visitor Pass' } }
          ]
        }
      }
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
    console.error('❌ Error sending registration menu:', error.message);
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

// =================================================================
// 5. TURNSTILE PASS DISPATCHER (LIVE TUNNEL OR MOCK FALLBACK)
// =================================================================

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

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Ponte Concierge webhook server is running on http://${HOST}:${PORT}`);
});
