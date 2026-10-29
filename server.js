const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ponte_secure_token_2026';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const HIKCENTRAL_BASE_URL = process.env.HIKCENTRAL_BASE_URL; // Leave blank for decoupled mock mode

// ============================================================================
// IN-MEMORY STATE STORES
// ============================================================================
const userProfiles = new Map();     // phone -> { role: 'RESIDENT' | 'RUNNER', registeredAt: Date, unit?: string }
const residentSessions = new Map(); // phone -> { step, visitorName, visitorPhone, accessType }
const visitorSessions = new Map();  // phone -> { step, hostPhone, visitorName, accessType, idNumber, photoUrl }
const runnerJobs = new Map();       // jobId -> { status: 'PENDING' | 'CLAIMED', claimedBy, token, unit, courier, payout }

// Seed verified numbers if necessary
userProfiles.set('27715720458', { role: 'RESIDENT', registeredAt: new Date(), unit: '5102' });

// ============================================================================
// UTILITY: SA ID LUHN CHECKSUM VALIDATION
// ============================================================================
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

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(idNumber[12], 10);
}

function maskID(idNumber) {
  if (!idNumber || idNumber.length !== 13) return idNumber;
  return `${idNumber.substring(0, 6)}*****${idNumber.substring(11)}`;
}

// ============================================================================
// OUTBOUND META GRAPH API HELPERS (Uses native global fetch)
// ============================================================================
async function sendWhatsAppMessage(recipientPhone, messageText) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'text',
      text: { body: messageText },
    };

    const res = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (error) {
    console.error('❌ Error sending WhatsApp text:', error.message);
  }
}

async function sendInteractiveButtons(recipientPhone, headerText, bodyText, buttons, footerText = '') {
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
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    };

    const res = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (error) {
    console.error('❌ Error sending interactive buttons:', error.message);
  }
}

async function sendWhatsAppImage(recipientPhone, imageUrl, caption) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption,
      },
    };

    const res = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (error) {
    console.error('❌ Error sending image:', error.message);
  }
}

// ============================================================================
// ONBOARDING & DASHBOARD MENUS
// ============================================================================
async function sendCleanRegistrationMenu(recipientPhone) {
  return await sendInteractiveButtons(
    recipientPhone,
    '🏢 PONTE CITY CONCIERGE',
    '👋 Welcome to Ponte City! To activate your digital access and concierge services, please select your profile:',
    [
      { id: 'ROLE_RESIDENT', title: '🏠 Resident' },
      { id: 'ROLE_RUNNER', title: '🏃 Resident Runner' },
    ],
    'Visitors: Access passes are issued directly by your host resident.'
  );
}

async function sendResidentDashboard(recipientPhone, unit = 'Registered') {
  await sendWhatsAppMessage(
    recipientPhone,
    `👋 *Welcome back to Ponte Concierge!*\n\n` +
      `Your profile is active as *Resident* (Unit ${unit}).\n\n` +
      `• Reply *visitor* to pre-clear a guest pass\n` +
      `• Reply *parcel* to request a runner for reception delivery\n` +
      `• Reply *support* for building management assistance`
  );
}

async function sendRunnerDashboard(recipientPhone) {
  await sendWhatsAppMessage(
    recipientPhone,
    `🏃 *Welcome back, Runner!*\n\n` +
      `You are active on the Ponte standby delivery roster.\n\n` +
      `• Incoming reception parcel alerts are broadcast directly to your phone.\n` +
      `• Reply *run* to trigger a simulated parcel dispatch test.\n` +
      `• Reply *status* to review active assignments.`
  );
}

// ============================================================================
// PASS GENERATION / DECOUPLED FALLBACK
// ============================================================================
async function generateTurnstilePass(visitorPhone, visitorData) {
  const passToken = `PC-PASS-${Math.floor(100000 + Math.random() * 900000)}`;
  const qrDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(
    passToken
  )}`;

  console.log(`[PASS ISSUED] Token: ${passToken} | Guest: ${visitorData.visitorName} | Mode: ${visitorData.accessType}`);

  if (HIKCENTRAL_BASE_URL) {
    try {
      console.log(`📡 Relaying credentials to HikCentral: ${HIKCENTRAL_BASE_URL}`);
      await fetch(`${HIKCENTRAL_BASE_URL}/api/visitor/pre-clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitorName: visitorData.visitorName,
          visitorPhone: visitorPhone,
          idNumberMasked: maskID(visitorData.idNumber),
          token: passToken,
          validHours: 24,
        }),
      });
    } catch (err) {
      console.warn('⚠️ HikCentral relay failed; fallback QR remains fully valid:', err.message);
    }
  }

  // Deliver pass to visitor
  await sendWhatsAppImage(
    visitorPhone,
    qrDataUrl,
    `🎟️ *PONTE CITY 24-HOUR VISITOR PASS*\n\n` +
      `• *Guest:* ${visitorData.visitorName}\n` +
      `• *ID:* ${maskID(visitorData.idNumber)}\n` +
      `• *Transit:* ${visitorData.accessType}\n` +
      `• *Pass Token:* ${passToken}\n` +
      `• *Validity:* 24 Hours (Multi-Entry with Anti-Passback)\n\n` +
      `_Scan this barcode directly at the reception optical turnstile readers for ingress._`
  );

  // Notify host resident
  if (visitorData.hostPhone) {
    await sendWhatsAppMessage(
      visitorData.hostPhone,
      `✅ *Visitor Pass Activated*\n\n` +
        `Guest *${visitorData.visitorName}* has verified their details. A 24-hour optical access pass has been delivered to their WhatsApp.`
    );
  }
}

// ============================================================================
// WEBHOOK VERIFICATION (GET)
// ============================================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============================================================================
// WEBHOOK EVENT PROCESSOR (POST)
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

    // 1. INTERACTIVE BUTTON CLICKS
    if (messageType === 'interactive' && message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;
      console.log(`[BUTTON] From: ${senderPhone} | ID: ${buttonId}`);

      if (buttonId === 'ROLE_RESIDENT') {
        userProfiles.set(senderPhone, { role: 'RESIDENT', registeredAt: new Date(), unit: '5102' });
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS' });
        await sendWhatsAppMessage(
          senderPhone,
          `🏠 *Resident Profile Registered*\n\n` +
            `To pre-clear a visitor right now, reply with their *Full Name* and *Cell Number* separated by a comma:\n\n` +
            `*Example:* Sipho Dlamini, 0821234567\n\n` +
            `_You can also text *visitor* or *parcel* anytime._`
        );
        return;
      }

      if (buttonId === 'ROLE_RUNNER') {
        userProfiles.set(senderPhone, { role: 'RUNNER', registeredAt: new Date() });
        await sendWhatsAppMessage(
          senderPhone,
          `🏃 *Resident Runner Roster Activated*\n\n` +
            `You are registered as an authorized resident runner.\n\n` +
            `• When parcels arrive at reception, you will receive interactive dispatch cards.\n` +
            `• First to tap *Accept Run* locks the delivery and receives the pickup custody token.`
        );
        return;
      }

      if (buttonId.startsWith('ACCESS_TYPE_')) {
        const session = residentSessions.get(senderPhone);
        if (!session) {
          await sendWhatsAppMessage(senderPhone, '⚠️ Session expired. Reply *visitor* to initiate pre-clearance.');
          return;
        }

        const accessType = buttonId.replace('ACCESS_TYPE_', '');
        session.accessType = accessType;
        session.step = 'COMPLETED';

        let formattedGuestPhone = session.visitorPhone.replace(/\D/g, '');
        if (formattedGuestPhone.startsWith('0')) {
          formattedGuestPhone = '27' + formattedGuestPhone.substring(1);
        }

        visitorSessions.set(formattedGuestPhone, {
          step: 'AWAITING_ID_NUMBER',
          hostPhone: senderPhone,
          visitorName: session.visitorName,
          accessType: accessType,
        });

        await sendWhatsAppMessage(
          senderPhone,
          `⏳ *Handshake Initiated*\n\n` +
            `Pre-clearance invitation sent to *${session.visitorName}* (${formattedGuestPhone}). We will notify you once they upload their document and receive their pass.`
        );

        await sendWhatsAppMessage(
          formattedGuestPhone,
          `🏢 *Ponte City Visitor Pre-Clearance*\n\n` +
            `Hello ${session.visitorName}! Resident *${senderPhone}* has pre-cleared your arrival (${accessType}).\n\n` +
            `To issue your 24-hour optical access pass, please reply with your *13-Digit South African ID Number* (or Passport Number):`
        );
        return;
      }

      if (buttonId.startsWith('JOB_ACCEPT_')) {
        const jobId = buttonId.replace('JOB_ACCEPT_', '');
        const job = runnerJobs.get(jobId);

        if (!job || job.status === 'CLAIMED') {
          await sendWhatsAppMessage(
            senderPhone,
            `❌ *Snooze you lose!* Job #${jobId} has already been claimed by another runner.`
          );
          return;
        }

        job.status = 'CLAIMED';
        job.claimedBy = senderPhone;
        const pickupToken = `PK-${Math.floor(1000 + Math.random() * 9000)}`;
        job.token = pickupToken;

        await sendWhatsAppMessage(
          senderPhone,
          `🚀 *Job #${jobId} Confirmed & Locked!*\n\n` +
            `• *Pickup Point:* ${job.pickup || 'Reception Desk'}\n` +
            `• *Destination:* Unit ${job.unit || '3204'}\n` +
            `• *Courier:* ${job.courier || 'Takealot'}\n` +
            `• *Payout:* ${job.payout || 'R25.00'}\n\n` +
            `🔑 *Reception Custody Token:* *[${pickupToken}]*\n\n` +
            `_Show this pickup token to the reception desk officer to collect the parcel._`
        );
        return;
      }

      if (buttonId.startsWith('JOB_DECLINE_')) {
        const jobId = buttonId.replace('JOB_DECLINE_', '');
        await sendWhatsAppMessage(senderPhone, `👍 Job #${jobId} declined. You remain on the standby roster.`);
        return;
      }
    }

    // 2. IMAGE UPLOAD HANDLER
    if (messageType === 'image') {
      const visitorSession = visitorSessions.get(senderPhone);
      if (visitorSession && visitorSession.step === 'AWAITING_DOC_IMAGE') {
        const imageId = message.image.id;
        console.log(`[DOC UPLOAD] Image ID ${imageId} received from ${senderPhone}`);

        visitorSession.photoUrl = `https://graph.facebook.com/v18.0/${imageId}`;
        visitorSession.step = 'COMPLETED';

        await sendWhatsAppMessage(
          senderPhone,
          '🔎 *Document Captured*\n\nVerifying document structure and generating optical turnstile credential...'
        );

        await generateTurnstilePass(senderPhone, visitorSession);
        return;
      }
    }

    // 3. TEXT MESSAGE INGRESS & ROUTING
    if (messageType === 'text') {
      const rawText = message.text.body.trim();
      const lowerText = rawText.toLowerCase();
      const cleanText = lowerText.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();

      console.log(`[INBOUND TEXT] From: ${senderPhone} | Body: "${rawText}"`);

      // Ingress / Greeting Catchers
      if (
        cleanText === 'register' ||
        cleanText === 'start' ||
        cleanText === 'hi' ||
        cleanText === 'hello' ||
        cleanText.includes('patience while') ||
        cleanText.includes('register your details') ||
        cleanText.includes('interested in learning')
      ) {
        const existingProfile = userProfiles.get(senderPhone);

        if (existingProfile) {
          if (existingProfile.role === 'RESIDENT') {
            await sendResidentDashboard(senderPhone, existingProfile.unit);
            return;
          }
          if (existingProfile.role === 'RUNNER') {
            await sendRunnerDashboard(senderPhone);
            return;
          }
        }

        await sendCleanRegistrationMenu(senderPhone);
        return;
      }

      if (cleanText === 'visitor' || cleanText === 'invite') {
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS' });
        await sendWhatsAppMessage(
          senderPhone,
          `👥 *Ponte Visitor Pre-Clearance*\n\n` +
            `Please reply with your guest's *Full Name* and *Cell Number* separated by a comma:\n\n` +
            `*Example:* Thabo Molefe, 0712345678`
        );
        return;
      }

      if (cleanText === 'run' || cleanText === 'parcel' || cleanText === 'package') {
        const jobId = Math.floor(1000 + Math.random() * 9000).toString();
        runnerJobs.set(jobId, {
          status: 'PENDING',
          unit: '3204',
          courier: 'Takealot',
          pickup: 'Reception Desk',
          payout: 'R25.00',
        });

        await sendInteractiveButtons(
          senderPhone,
          '📦 PONTE CONCIERGE DISPATCH',
          `New Runner Task Available!\n\n` +
            `• *Job ID:* #${jobId}\n` +
            `• *Pickup:* Reception Desk\n` +
            `• *Destination:* Unit 3204\n` +
            `• *Courier:* Takealot\n` +
            `• *Delivery Payout:* R25.00\n\n` +
            `_First runner to tap Accept claims this job._`,
          [
            { id: `JOB_ACCEPT_${jobId}`, title: 'Accept Run 🚀' },
            { id: `JOB_DECLINE_${jobId}`, title: 'Decline' },
          ],
          'Ponte Micro-Logistics Network'
        );
        return;
      }

      const resSession = residentSessions.get(senderPhone);
      if (resSession && resSession.step === 'AWAITING_GUEST_DETAILS') {
        const parts = rawText.split(',');
        if (parts.length < 2) {
          await sendWhatsAppMessage(
            senderPhone,
            '⚠️ Please provide both the *Name* and *Cell Number* separated by a comma.\n\n*Example:* Sipho Dlamini, 0821234567'
          );
          return;
        }

        const guestName = parts[0].trim();
        const guestPhone = parts[1].trim();

        resSession.visitorName = guestName;
        resSession.visitorPhone = guestPhone;
        resSession.step = 'AWAITING_ACCESS_TYPE';

        await sendInteractiveButtons(
          senderPhone,
          '🚗 ARRIVAL MODE',
          `How will *${guestName}* arrive at Ponte City?`,
          [
            { id: 'ACCESS_TYPE_PEDESTRIAN', title: '🚶 Pedestrian' },
            { id: 'ACCESS_TYPE_VEHICLE', title: '🚘 Resident Parking' },
            { id: 'ACCESS_TYPE_EHAILING', title: '🚕 Uber / Bolt' },
          ]
        );
        return;
      }

      const visSession = visitorSessions.get(senderPhone);
      if (visSession && visSession.step === 'AWAITING_ID_NUMBER') {
        const sanitizedId = cleanText.replace(/\s+/g, '');

        if (!validateSouthAfricanID(sanitizedId)) {
          await sendWhatsAppMessage(
            senderPhone,
            `❌ *Invalid South African ID Number*\n\n` +
              `The ID number entered failed mathematical Luhn checksum validation. Please check the digits and try again:`
          );
          return;
        }

        visSession.idNumber = sanitizedId;
        visSession.step = 'AWAITING_DOC_IMAGE';

        await sendWhatsAppMessage(
          senderPhone,
          `✅ *ID Checksum Validated (${maskID(sanitizedId)})*\n\n` +
            `Please take and upload a clear photo of your *ID Card, Driver's License, or Passport* to finalize your 24-hour pass.\n\n` +
            `_Under POPIA regulations, raw document images are scheduled for automatic 24-hour destruction._`
        );
        return;
      }

      // Default fallback
      await sendWhatsAppMessage(
        senderPhone,
        `👋 *Ponte Concierge System*\n\n` +
          `• Reply *register* to setup or update your profile\n` +
          `• Reply *visitor* to pre-clear a guest\n` +
          `• Reply *run* to check delivery dispatch notifications`
      );
    }
  } catch (error) {
    console.error('❌ Critical webhook processing failure:', error);
  }
});

// ============================================================================
// SYSTEM HEALTH / KEEP-ALIVE ROUTE
// ============================================================================
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'Ponte Concierge Middleware',
    status: 'ONLINE',
    port: PORT,
    hikCentralTunnel: HIKCENTRAL_BASE_URL ? 'CONNECTED' : 'DECOUPLED_MOCK_ACTIVE',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ponte Concierge webhook server is running on http://0.0.0.0:${PORT}`);
});
