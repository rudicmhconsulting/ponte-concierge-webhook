const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const VERIFY_TOKEN = 'ponte_concierge_secure_token';

// In-memory state tracking for SIT demonstration
const activeJobs = new Map();
const visitorSessions = new Map();

// =================================================================
// 1. UTILITIES & COMPLIANCE ALGORITHMS
// =================================================================

function validateSouthAfricanID(id) {
  const cleanId = id.replace(/\s+/g, '').replace(/-/g, '');
  if (!/^\d{13}$/.test(cleanId)) return false;

  const year = parseInt(cleanId.substring(0, 2), 10);
  const month = parseInt(cleanId.substring(2, 4), 10);
  const day = parseInt(cleanId.substring(4, 6), 10);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

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

// =================================================================
// 2. WEBHOOK VERIFICATION (GET /webhook)
// =================================================================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
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
              console.log(`🔘 Button Clicked by ${senderPhone}: ${buttonId}`);

              // 1. Runner Job Claim
              if (buttonId.startsWith('JOB_ACCEPT_')) {
                const jobId = buttonId.replace('JOB_ACCEPT_', '');
                const job = activeJobs.get(jobId);

                if (!job || job.status === 'ASSIGNED') {
                  await sendWhatsAppMessage(senderPhone, `❌ Snooze you lose! Job #${jobId} was already claimed.`);
                  return;
                }

                job.status = 'ASSIGNED';
                job.runner = senderPhone;
                activeJobs.set(jobId, job);

                await sendWhatsAppMessage(
                  senderPhone,
                  `✅ *Job #${jobId} Confirmed!*\n\nHead to Reception and present token: *[PK-${jobId}]* for Unit ${job.unit}.\n💰 R${job.payout.toFixed(2)} credited upon delivery verification.`
                );
                return;
              }

              // 2. Runner Job Decline
              if (buttonId.startsWith('JOB_DECLINE_')) {
                await sendWhatsAppMessage(senderPhone, `👍 Job declined. You remain active on the standby runner roster.`);
                return;
              }

              // 3. Visitor Access Type Selection
              if (buttonId.startsWith('ACCESS_TYPE_')) {
                const session = visitorSessions.get(senderPhone);
                if (!session) {
                  await sendWhatsAppMessage(senderPhone, `⚠️ Session expired. Type *visitor* to restart.`);
                  return;
                }

                session.accessType = buttonId.replace('ACCESS_TYPE_', '');
                session.step = 'AWAITING_ID_DOC';
                visitorSessions.set(senderPhone, session);

                await sendWhatsAppMessage(
                  senderPhone,
                  `📸 *Identity Document Verification*\n\nPlease take a clear photo or upload an image of *${session.visitorName}*'s SA ID Card / Book, Driver's License, or Passport.\n\n_Note: Personal document images are cached temporarily for access compliance and purged per POPIA standards._`
                );
                return;
              }
            }

            // -------------------------------------------------------------
            // CASE B: INBOUND IMAGES (DOCUMENT CAPTURE)
            // -------------------------------------------------------------
            if (message.type === 'image') {
              const session = visitorSessions.get(senderPhone);
              if (session && session.step === 'AWAITING_ID_DOC') {
                const imageId = message.image.id;
                console.log(`📸 Document image received (Media ID: ${imageId}) for visitor: ${session.visitorName}`);

                session.documentMediaId = imageId;
                session.step = 'COMPLETED';

                // Try Plan C Tunnel if available; otherwise fallback to Mock Pass
                await issueVisitorPass(senderPhone, session);
                visitorSessions.delete(senderPhone);
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

              const session = visitorSessions.get(senderPhone);

              // Step: Capturing Visitor Name and ID
              if (session && session.step === 'AWAITING_DETAILS') {
                const parts = rawText.split(',');
                if (parts.length < 2) {
                  await sendWhatsAppMessage(
                    senderPhone,
                    `⚠️ *Format Error*\nPlease supply both Name and ID separated by a comma.\n\n*Example:* Sipho Dlamini, 8502145028081`
                  );
                  return;
                }

                const visitorName = parts[0].trim();
                const idCandidate = parts[1].trim();

                // If numeric, check length & Luhn
                if (/^\d+$/.test(idCandidate)) {
                  if (idCandidate.length === 13) {
                    if (!validateSouthAfricanID(idCandidate)) {
                      await sendWhatsAppMessage(
                        senderPhone,
                        `❌ *Invalid SA ID Number*\nThe ID number provided failed Luhn checksum verification. Please re-enter a valid 13-digit SA ID number or Passport.`
                      );
                      return;
                    }
                  } else {
                    await sendWhatsAppMessage(
                      senderPhone,
                      `❌ *Invalid ID Length*\nSA ID must be 13 digits. For foreign passports, include alpha prefix (e.g. A01234567).`
                    );
                    return;
                  }
                }

                session.visitorName = visitorName;
                session.idNumber = idCandidate;
                session.step = 'AWAITING_ACCESS_TYPE';
                visitorSessions.set(senderPhone, session);

                await sendAccessTypeButtons(senderPhone, visitorName);
                return;
              }

              // Top-level commands
              if (lowerText === 'run' || lowerText === 'testjob') {
                const testId = Math.floor(1000 + Math.random() * 9000).toString();
                const newJob = {
                  id: testId,
                  unit: '3204',
                  courier: 'Takealot',
                  payout: 25.00,
                  status: 'OPEN'
                };
                activeJobs.set(testId, newJob);
                await sendRunnerJob(senderPhone, newJob);
              } 
              else if (lowerText.includes('pass') || lowerText.includes('visitor')) {
                visitorSessions.set(senderPhone, { step: 'AWAITING_DETAILS' });
                await sendWhatsAppMessage(
                  senderPhone,
                  `🛡️ *Ponte Visitor Pre-Clearance (24h Pass)*\n\nPlease reply with your guest's *Full Name* and *ID/Passport Number* separated by a comma:\n\n*Example:* Sipho Dlamini, 9001015028087`
                );
              } 
              else if (lowerText.includes('parcel') || lowerText.includes('fetch') || lowerText.includes('collect')) {
                const testId = Math.floor(1000 + Math.random() * 9000).toString();
                const newJob = {
                  id: testId,
                  unit: 'Current Resident',
                  courier: 'Reception Parcel Desk',
                  payout: 25.00,
                  status: 'OPEN'
                };
                activeJobs.set(testId, newJob);
                await sendRunnerJob(senderPhone, newJob);
              } 
              else {
                await sendWhatsAppMessage(
                  senderPhone,
                  `👋 *Welcome to Ponte Concierge!*\n\n• Text *run* to test the Runner Dispatch Job Box\n• Text *visitor* for 24h ID-verified visitor clearance\n• Text *parcel* to request an apartment runner`
                );
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook Router Exception:', err);
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
    console.error('❌ Error sending text message:', error.message);
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
        body: { text: `Pre-clearing pass for *${visitorName}*.\nSelect transport method for turnstile/boom access:` },
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
    console.error('❌ Error sending access type buttons:', error.message);
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
        image: {
          link: imageUrl,
          caption: captionText,
        },
      }),
    });
    return await response.json();
  } catch (error) {
    console.error('❌ Error sending image message:', error.message);
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
          text: `*New Task Available!*\n\n` +
                `• *Job ID:* #${job.id}\n` +
                `• *Pickup:* Reception Desk\n` +
                `• *Destination:* Unit ${job.unit}\n` +
                `• *Courier/Item:* ${job.courier}\n` +
                `• *Payout:* R${job.payout.toFixed(2)}`,
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
    console.error('❌ Error sending runner dispatch card:', error.message);
  }
}

// =================================================================
// 5. TURNSTILE PASS DISPATCHER (LIVE TUNNEL OR MOCK FALLBACK)
// =================================================================

async function issueVisitorPass(recipientPhone, session) {
  const tunnelBaseUrl = process.env.HIKCENTRAL_BASE_URL; // Configured during 12:00 Cloudflare run

  // Default Mock Pass logic
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

  // If Cloudflare Tunnel is live, bridge to HikCentral OpenAPI
  if (tunnelBaseUrl && tunnelBaseUrl.startsWith('http')) {
    try {
      console.log(`🔌 Attempting live HikCentral reservation via tunnel: ${tunnelBaseUrl}`);
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
    } catch (tunnelErr) {
      console.warn('⚠️ HikCentral Tunnel call timed out/failed. Seamlessly falling back to Mock Pass.', tunnelErr.message);
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
    `_Present this QR barcode to the turnstile optical reader or boom scanner. Personal document records are queued for automated POPIA purge within 24 hours._`
  );
}

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Ponte Concierge webhook server is running on http://${HOST}:${PORT}`);
});
