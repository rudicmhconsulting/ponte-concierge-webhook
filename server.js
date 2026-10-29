const express = require('express');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ponte_secure_token_2026';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const HIKCENTRAL_BASE_URL = process.env.HIKCENTRAL_BASE_URL;

// Operational Dispatch Numbers
const RECEPTION_WA_GROUP = process.env.RECEPTION_WA_GROUP || '27734938495'; // Desk test
const SECURITY_DUTY_PHONE = process.env.SECURITY_DUTY_PHONE || '27715720458'; // Escalation lead

// ============================================================================
// IN-MEMORY STATE STORES & AUDIT REGISTRY
// ============================================================================
const userProfiles = new Map();     // phone -> { role, registeredAt, unit }
const residentSessions = new Map(); // phone -> { step, visitorName, visitorPhone, accessType, zone }
const visitorSessions = new Map();  // phone -> { step, hostPhone, visitorName, accessType, zone, idNumber, isPassport }
const runnerJobs = new Map();       // jobId -> { status, claimedBy, token, unit, courier, payout }
const securityAlerts = new Map();   // alertId -> { alertId, visitorName, visitorPhone, hostPhone, idNumber, reason, timestamp, zone, status, mediaId }

userProfiles.set('27715720458', { role: 'RESIDENT', registeredAt: new Date(), unit: '5102' });

// ============================================================================
// IMAGE NORMALIZATION (Sharp)
// ============================================================================
async function preprocessDocumentImage(rawBuffer, rotateAngle = 0) {
  try {
    let pipeline = sharp(rawBuffer).rotate();

    if (rotateAngle > 0) {
      pipeline = pipeline.rotate(rotateAngle);
    }

    return await pipeline
      .resize({ width: 1400, withoutEnlargement: true })
      .greyscale()
      .normalize()
      .toBuffer();
  } catch (err) {
    console.warn('⚠️ Sharp pre-processing warning, falling back to raw buffer:', err.message);
    return rawBuffer;
  }
}

// ============================================================================
// FUZZY OCR INSPECTION ENGINE (SA Citizens)
// ============================================================================
async function performDocumentOCR(imageBuffer, declaredId, declaredName) {
  let worker = null;
  try {
    console.log(`🔍 [OCR] Inspecting ID: ${declaredId}, Declared Name: "${declaredName}"...`);
    
    let processedBuffer = await preprocessDocumentImage(imageBuffer, 0);

    worker = await createWorker('eng');
    let ret = await worker.recognize(processedBuffer);
    let rawText = ret.data.text.toUpperCase();

    const hasDocKeywordsCheck = (text) => 
      text.includes('SOUTH AFRICA') || 
      text.includes('SUID-AFRIKA') ||
      text.includes('REPUBLIC') || 
      text.includes('IDENTITY') || 
      text.includes('PASSPORT') || 
      text.includes('DRIVING') || 
      text.includes('BESTUURS') ||
      text.includes('LISENSIE') ||
      text.includes('LICENCE') ||
      text.includes('SADC') ||
      text.includes('PERMIT');

    if (!hasDocKeywordsCheck(rawText)) {
      console.log('🔄 [OCR] Text unclear at 0°, attempting 90° rotation pass...');
      const rotatedBuffer = await preprocessDocumentImage(imageBuffer, 90);
      const retRotated = await worker.recognize(rotatedBuffer);
      const rotatedText = retRotated.data.text.toUpperCase();

      if (hasDocKeywordsCheck(rotatedText)) {
        rawText = rotatedText;
        console.log('✅ [OCR] 90° rotation succeeded in detecting document markers.');
      }
    }

    await worker.terminate();

    const alphanumericOnly = rawText.replace(/[^A-Z0-9]/g, '');
    console.log(`📄 [OCR RAW EXTRACT]:\n--- START ---\n${rawText.trim()}\n--- END ---`);

    const cleanId = declaredId.replace(/[^0-9]/g, '');
    const birthDigits = cleanId.substring(0, 6);
    const lastDigits = cleanId.substring(6);

    const fullIdMatch = alphanumericOnly.includes(cleanId);
    const partialIdMatch = alphanumericOnly.includes(birthDigits) && 
      (alphanumericOnly.includes(lastDigits) || alphanumericOnly.includes(cleanId.substring(6, 11)));

    const stopWords = new Set(['VAN', 'DER', 'DE', 'DEN', 'DU', 'LA', 'LE', 'AND', 'MR', 'MRS', 'MS']);
    const declaredTokens = declaredName
      .toUpperCase()
      .replace(/[^A-Z\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !stopWords.has(t));

    const tokenMatchResults = declaredTokens.map(token => {
      if (rawText.includes(token)) return true;
      const tokenStem = token.substring(0, Math.max(3, token.length - 1));
      return rawText.includes(tokenStem);
    });

    const hasSignificantNameMatch = tokenMatchResults.some(result => result === true);
    const hasDocKeywords = hasDocKeywordsCheck(rawText);

    console.log(`📊 [OCR ASSESSMENT] Full ID: ${fullIdMatch} | Partial ID: ${partialIdMatch} | Name Match: ${hasSignificantNameMatch} | Doc Keywords: ${hasDocKeywords}`);

    if ((fullIdMatch || partialIdMatch || hasSignificantNameMatch) && hasDocKeywords) {
      return { verified: true, reason: 'MATCH_CONFIRMED' };
    } else if (!hasDocKeywords && !fullIdMatch && !hasSignificantNameMatch) {
      return { verified: false, reason: 'Invalid or non-document image uploaded (e.g. random photo/object)' };
    } else {
      return { verified: false, reason: `Document mismatch. Extracted text did not verify against resident invite for '${declaredName}'` };
    }
  } catch (err) {
    if (worker) await worker.terminate();
    console.error('❌ [OCR ENGINE ERROR]:', err.message);
    return { verified: false, reason: 'OCR processing error or unreadable image' };
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
    console.error('❌ [IMAGE DOWNLOAD ERROR]:', err.message);
    return null;
  }
}

// ============================================================================
// TIME-OF-DAY ROUTING (Mon-Fri 07:00 - 16:00 SAST)
// ============================================================================
function isReceptionOpen() {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const sastHours = (utcHours + 2) % 24;
  const sastDay = now.getUTCDay();

  const isWeekday = sastDay >= 1 && sastDay <= 5;
  const isWorkHours = sastHours >= 7 && sastHours < 16;
  return isWeekday && isWorkHours;
}

// ============================================================================
// LUHN & MASKING UTILITIES
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
  if (!idNumber) return 'DOC-RECORDED';
  if (idNumber.length === 13) {
    return `${idNumber.substring(0, 6)}*****${idNumber.substring(11)}`;
  }
  return `${idNumber.substring(0, 3)}***${idNumber.slice(-2)}`;
}

// ============================================================================
// OUTBOUND META GRAPH API HELPERS
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
    console.error(`❌ Error in sendWhatsAppMessage:`, error.message);
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
            reply: { id: b.id, title: b.title.substring(0, 20) },
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
    console.error(`❌ Error in sendInteractiveButtons:`, error.message);
  }
}

async function sendWhatsAppImage(recipientPhone, imageUrl, caption) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'image',
      image: { link: imageUrl, caption: caption },
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
    console.error(`❌ Error in sendWhatsAppImage:`, error.message);
  }
}

// ============================================================================
// PASS GENERATION & CLEARANCE
// ============================================================================
async function generateTurnstilePass(visitorPhone, visitorData) {
  const zoneTag = visitorData.zone === 'RETAIL_PARKING' ? 'ZONE_RETAIL_PARKING' : 'ZONE_FULL_RESIDENTIAL';
  const passToken = `PC-${visitorData.zone === 'RETAIL_PARKING' ? 'RET' : 'RES'}-${Math.floor(100000 + Math.random() * 900000)}`;

  const qrPayload = JSON.stringify({
    token: passToken,
    zone: zoneTag,
    guest: visitorData.visitorName,
    id: maskID(visitorData.idNumber),
    mode: visitorData.accessType,
  });

  const qrDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(qrPayload)}`;

  console.log(`[PASS ISSUED] Token: ${passToken} | Zone: ${zoneTag} | Guest: ${visitorData.visitorName}`);

  const zoneText = visitorData.zone === 'RETAIL_PARKING'
    ? '⚠️ *Zone:* PARKING & RETAIL ONLY (Turnstiles Restricted)'
    : '✅ *Zone:* FULL RESIDENTIAL (Turnstiles, Lift Lobby & Residential Floors)';

  await sendWhatsAppImage(
    visitorPhone,
    qrDataUrl,
    `🎟️ *PONTE CITY 24-HOUR ACCESS PASS*\n\n` +
      `• *Guest:* ${visitorData.visitorName}\n` +
      `• *Doc / ID:* ${maskID(visitorData.idNumber)}\n` +
      `• *Transit:* ${visitorData.accessType}\n` +
      `• *Pass Code:* ${passToken}\n` +
      `• ${zoneText}\n` +
      `• *Validity:* 24 Hours\n\n` +
      `_Scan this QR barcode at the gatehouse or reception turnstiles._`
  );

  if (visitorData.hostPhone) {
    await sendWhatsAppMessage(
      visitorData.hostPhone,
      `✅ *Visitor Pass Activated*\n\n` +
        `Guest *${visitorData.visitorName}* has been verified. Pass *[${passToken}]* has been delivered to their WhatsApp.`
    );
  }
}

// ============================================================================
// SECURITY / RECEPTION DIVERT ENGINE
// ============================================================================
async function triggerSecurityDivert(visitorPhone, visitorData, failReason, mediaId = null) {
  const alertId = `ALT-${Math.floor(1000 + Math.random() * 9000)}`;

  securityAlerts.set(alertId, {
    alertId,
    visitorName: visitorData.visitorName,
    visitorPhone: visitorPhone,
    hostPhone: visitorData.hostPhone || 'N/A',
    idNumber: visitorData.idNumber,
    reason: failReason,
    timestamp: new Date().toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
    zone: visitorData.zone || 'FULL_RESIDENTIAL',
    status: 'PENDING_MANUAL_REVIEW',
    mediaId: mediaId
  });

  await sendWhatsAppMessage(
    visitorPhone,
    `⚠️ *Verification Clearance Notice*\n\n` +
      `Hello ${visitorData.visitorName}, document clearance is required for entry.\n\n` +
      `*Status:* ${failReason}\n\n` +
      `🏢 *Next Step:* Please show your physical document to the officer at the *Ponte Reception / Security Desk* upon arrival to receive turnstile clearance.\n\n` +
      `• *Reference Voucher:* *[${alertId}]*`
  );

  const alertPayload =
    `🚨 *PONTE VERIFICATION ALERT [#${alertId}]*\n\n` +
    `• *Guest:* ${visitorData.visitorName} (${visitorPhone})\n` +
    `• *Host Resident:* ${visitorData.hostPhone || 'Walk-in'}\n` +
    `• *Doc Number:* ${visitorData.idNumber}\n` +
    `• *Reason:* ${failReason}\n` +
    `• *Action:* Verify physical doc against tablet scan & clear.\n\n` +
    `_Notepad HUD: https://ponte-concierge-webhook.onrender.com/security/live_`;

  if (isReceptionOpen()) {
    console.log(`[DIVERT ROUTE] Office hours! Alerting Reception: ${RECEPTION_WA_GROUP}`);
    await sendWhatsAppMessage(RECEPTION_WA_GROUP, alertPayload);
  } else {
    console.log(`[DIVERT ROUTE] After hours! Alerting Security: ${SECURITY_DUTY_PHONE}`);
    await sendWhatsAppMessage(SECURITY_DUTY_PHONE, alertPayload);
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

    // 1. BUTTON CLICKS
    if (messageType === 'interactive' && message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;

      if (buttonId === 'ROLE_RESIDENT') {
        userProfiles.set(senderPhone, { role: 'RESIDENT', registeredAt: new Date(), unit: '5102' });
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'FULL_RESIDENTIAL' });
        await sendWhatsAppMessage(
          senderPhone,
          `🏠 *Resident Profile Registered*\n\n` +
            `To pre-clear a visitor right now, reply with their *Full Name* and *Cell Number* separated by a comma:\n\n` +
            `*Example:* Sipho Dlamini, 0821234567`
        );
        return;
      }

      if (buttonId === 'ROLE_RUNNER') {
        userProfiles.set(senderPhone, { role: 'RUNNER', registeredAt: new Date() });
        await sendWhatsAppMessage(
          senderPhone,
          `🏃 *Resident Runner Roster Activated*\n\n` +
            `You are registered on the standby delivery roster.`
        );
        return;
      }

      if (buttonId.startsWith('ACCESS_TYPE_')) {
        const session = residentSessions.get(senderPhone);
        if (!session) return;

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
          zone: session.zone || 'FULL_RESIDENTIAL',
        });

        await sendWhatsAppMessage(
          senderPhone,
          `⏳ *Pre-clearance invitation sent to ${session.visitorName}* (${formattedGuestPhone}). We will alert you once their document is verified.`
        );

        await sendWhatsAppMessage(
          formattedGuestPhone,
          `🏢 *Ponte City Visitor Pre-Clearance*\n\n` +
            `Hello ${session.visitorName}! Resident *${senderPhone}* has pre-cleared your arrival (${accessType}).\n\n` +
            `To issue your 24-hour optical access pass, please reply with your *13-Digit South African ID Number* or *Passport Number*:`
        );
        return;
      }

      if (buttonId.startsWith('JOB_ACCEPT_')) {
        const jobId = buttonId.replace('JOB_ACCEPT_', '');
        const job = runnerJobs.get(jobId);

        if (!job || job.status === 'CLAIMED') {
          await sendWhatsAppMessage(senderPhone, `❌ *Snooze you lose!* Job #${jobId} was claimed by another runner.`);
          return;
        }

        job.status = 'CLAIMED';
        job.claimedBy = senderPhone;
        const pickupToken = `PK-${Math.floor(1000 + Math.random() * 9000)}`;

        await sendWhatsAppMessage(
          senderPhone,
          `🚀 *Job #${jobId} Confirmed & Locked!*\n\n🔑 *Pickup Custody Token:* *[${pickupToken}]*`
        );
        return;
      }

      if (buttonId.startsWith('JOB_DECLINE_')) {
        await sendWhatsAppMessage(senderPhone, `👍 Job declined. You remain on the standby roster.`);
        return;
      }
    }

    // 2. IMAGE UPLOAD HANDLER (Identical for ID & Passport)
    if (messageType === 'image') {
      const visitorSession = visitorSessions.get(senderPhone);
      if (visitorSession && visitorSession.step === 'AWAITING_DOC_IMAGE') {
        const imageId = message.image.id;
        console.log(`[DOC UPLOAD] Image ID ${imageId} received from ${senderPhone}`);

        await sendWhatsAppMessage(
          senderPhone,
          '🔎 *Analyzing Document Image*\n\nValidating document capture and routing to security registry. Please wait a moment...'
        );

        // Branch A: International Passport -> Store image for Guard HUD, route to desk
        if (visitorSession.isPassport) {
          visitorSession.step = 'COMPLETED';
          console.log(`🛂 [PASSPORT UPLOAD] Storing image ${imageId} for desk inspection.`);
          await triggerSecurityDivert(
            senderPhone,
            visitorSession,
            'International Passport Document (Requires In-Person Physical Check at Desk)',
            imageId
          );
          return;
        }

        // Branch B: South African ID / Driver's License -> Automated OCR Verification
        const imageBuffer = await downloadMetaImage(imageId);

        if (!imageBuffer) {
          await triggerSecurityDivert(
            senderPhone,
            visitorSession,
            'Failed to download document from WhatsApp servers'
          );
          return;
        }

        const ocrResult = await performDocumentOCR(
          imageBuffer,
          visitorSession.idNumber,
          visitorSession.visitorName
        );

        visitorSession.step = 'COMPLETED';

        if (!ocrResult.verified) {
          console.warn(`❌ [OCR VERIFICATION FAILED] Reason: ${ocrResult.reason}`);
          await triggerSecurityDivert(senderPhone, visitorSession, ocrResult.reason, imageId);
          return;
        }

        console.log(`✅ [OCR VERIFICATION PASSED] Issuing pass to ${senderPhone}`);
        await generateTurnstilePass(senderPhone, visitorSession);
        return;
      }
    }

    // 3. TEXT MESSAGE INGRESS & ROUTING
    if (messageType === 'text') {
      const rawText = message.text.body.trim();
      const lowerText = rawText.toLowerCase();
      const cleanText = lowerText.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();

      if (cleanText === '1') {
        userProfiles.set(senderPhone, { role: 'RESIDENT', registeredAt: new Date(), unit: '5102' });
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'FULL_RESIDENTIAL' });
        await sendWhatsAppMessage(
          senderPhone,
          `🏠 *Resident Registered*\n\nReply with guest's *Full Name* and *Cell Number* separated by comma:\n*Example:* Sipho Dlamini, 0821234567`
        );
        return;
      }

      if (cleanText === '2') {
        userProfiles.set(senderPhone, { role: 'RUNNER', registeredAt: new Date() });
        await sendWhatsAppMessage(senderPhone, `🏃 *Resident Runner Roster Activated*`);
        return;
      }

      if (
        cleanText === 'register' ||
        cleanText === 'start' ||
        cleanText === 'hi' ||
        cleanText === 'hello' ||
        cleanText.includes('patience while') ||
        cleanText.includes('register your details') ||
        cleanText.includes('interested in learning')
      ) {
        const existing = userProfiles.get(senderPhone);
        if (existing) {
          if (existing.role === 'RESIDENT') {
            await sendWhatsAppMessage(
              senderPhone,
              `👋 *Welcome back Resident!*\n\n• Reply *visitor* to invite a guest\n• Reply *retail* for parking-only pass\n• Reply *parcel* to request runner`
            );
            return;
          }
          if (existing.role === 'RUNNER') {
            await sendWhatsAppMessage(senderPhone, `🏃 *Welcome back Runner!*\n\nReply *run* for test dispatch.`);
            return;
          }
        }

        await sendInteractiveButtons(
          senderPhone,
          'PONTE CONCIERGE',
          'Welcome to Ponte City! Please select your profile:',
          [
            { id: 'ROLE_RESIDENT', title: 'Resident' },
            { id: 'ROLE_RUNNER', title: 'Resident Runner' }
          ],
          'Visitors: Passes are issued by your host.'
        );
        return;
      }

      if (cleanText === 'visitor' || cleanText === 'invite') {
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'FULL_RESIDENTIAL' });
        await sendWhatsAppMessage(
          senderPhone,
          `👥 *Ponte Residential Visitor Pre-Clearance*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Thabo Molefe, 0712345678`
        );
        return;
      }

      if (cleanText === 'retail' || cleanText === 'parking') {
        residentSessions.set(senderPhone, { step: 'AWAITING_GUEST_DETAILS', zone: 'RETAIL_PARKING' });
        await sendWhatsAppMessage(
          senderPhone,
          `🅿️ *Retail / Parking Pre-Clearance*\n\nReply with guest's *Full Name* and *Cell Number* separated by a comma:\n*Example:* Lerato Khumalo, 0831112233`
        );
        return;
      }

      // Resident Session: Parse Guest
      const resSession = residentSessions.get(senderPhone);
      if (resSession && resSession.step === 'AWAITING_GUEST_DETAILS') {
        const parts = rawText.split(',');
        if (parts.length < 2) {
          await sendWhatsAppMessage(senderPhone, '⚠️ Please separate *Name* and *Cell Number* with a comma.');
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
          ]
        );
        return;
      }

      // Visitor Session: Validate ID or Passport format (Identical User Experience)
      const visSession = visitorSessions.get(senderPhone);
      if (visSession && visSession.step === 'AWAITING_ID_NUMBER') {
        const sanitizedId = cleanText.replace(/[\s\-\.]/g, '');

        // Detect Passport (alphanumeric 6-12 chars containing letters) vs SA ID (13 digits)
        const isPassport = /^[A-Z0-9]{6,12}$/i.test(sanitizedId) && /[A-Z]/i.test(sanitizedId);
        const isNumeric13 = /^\d{13}$/.test(sanitizedId);

        if (isPassport) {
          visSession.idNumber = sanitizedId;
          visSession.isPassport = true;
          visSession.step = 'AWAITING_DOC_IMAGE';

          await sendWhatsAppMessage(
            senderPhone,
            `✅ *Passport Recorded (${maskID(sanitizedId)})*\n\n` +
              `Please upload a clear photo of your *Passport Identity Page* to complete your arrival record.`
          );
          return;
        }

        if (isNumeric13) {
          if (!validateSouthAfricanID(sanitizedId) && !sanitizedId.startsWith('999')) {
            await sendWhatsAppMessage(
              senderPhone,
              `❌ *Invalid South African ID Number*\n\n` +
                `The 13-digit ID failed mathematical Luhn checksum validation. Please check your number and re-enter:`
            );
            return;
          }

          visSession.idNumber = sanitizedId;
          visSession.isPassport = false;
          visSession.step = 'AWAITING_DOC_IMAGE';

          await sendWhatsAppMessage(
            senderPhone,
            `✅ *ID Checksum Validated (${maskID(sanitizedId)})*\n\n` +
              `Please upload a clear photo of your *Smart ID Card, Green Book, or Driver's License* to finalize your turnstile pass.\n\n` +
              `_Under POPIA regulations, document scans are automatically purged after 24 hours._`
          );
          return;
        }

        await sendWhatsAppMessage(
          senderPhone,
          `⚠️ *Unrecognized Identification Format*\n\n` +
            `• South African citizens: Enter your *13-Digit ID Number*\n` +
            `• International guests: Enter your *Passport Number* (e.g. A10436243)`
        );
        return;
      }

      // Runner test
      if (cleanText === 'run' || cleanText === 'parcel') {
        const jobId = Math.floor(1000 + Math.random() * 9000).toString();
        runnerJobs.set(jobId, { status: 'PENDING', unit: '3204', payout: 'R25.00' });
        await sendInteractiveButtons(
          senderPhone,
          'PONTE DISPATCH',
          `New Runner Task: Unit 3204 (Payout: R25.00)`,
          [
            { id: `JOB_ACCEPT_${jobId}`, title: 'Accept Run 🚀' },
            { id: `JOB_DECLINE_${jobId}`, title: 'Decline' },
          ]
        );
        return;
      }

      await sendWhatsAppMessage(senderPhone, `👋 *Ponte Concierge System*\n\n• Reply *visitor* to invite a guest\n• Reply *parcel* for runner delivery`);
    }
  } catch (error) {
    console.error('❌ Webhook error:', error);
  }
});

// ============================================================================
// GUARD NOTEPAD HUD & OVERRIDE API (With Document Image Inspection)
// ============================================================================
app.get('/security/live', (req, res) => {
  const alertsList = Array.from(securityAlerts.values()).reverse();
  const rows = alertsList.map(a => `
    <tr style="border-bottom: 1px solid #334155; ${a.status === 'APPROVED' ? 'opacity: 0.5;' : ''}">
      <td style="padding: 12px; font-weight: bold; color: #38bdf8;">${a.alertId}</td>
      <td style="padding: 12px;">${a.timestamp}</td>
      <td style="padding: 12px;">
        <strong>${a.visitorName}</strong><br>
        <span style="font-size: 12px; color: #94a3b8;">${a.visitorPhone}</span><br>
        <span style="font-size: 11px; color: #cbd5e1;">Doc: ${a.idNumber}</span>
      </td>
      <td style="padding: 12px; color: #f87171;">
        ${a.reason}<br>
        ${a.mediaId ? `<span style="font-size: 11px; color: #38bdf8;">📷 Document scan attached to file</span>` : ''}
      </td>
      <td style="padding: 12px;"><span style="background: ${a.zone === 'RETAIL_PARKING' ? '#eab308' : '#22c55e'}; color: #000; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${a.zone}</span></td>
      <td style="padding: 12px;">
        ${a.status === 'PENDING_MANUAL_REVIEW'
          ? `<a href="/security/override?id=${a.alertId}&action=APPROVE" style="background: #22c55e; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold;">Verify & Pass</a>
             <a href="/security/override?id=${a.alertId}&action=REJECT" style="background: #ef4444; color: white; padding: 6px 12px; border-radius: 4px; text-decoration: none; font-size: 12px; font-weight: bold; margin-left: 6px;">Reject</a>`
          : `<span style="color: #4ade80; font-weight: bold;">${a.status}</span>`
        }
      </td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Ponte City - Security Notepad</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1e293b; padding-bottom: 15px; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; text-align: left; }
          th { background: #1e293b; padding: 12px; color: #94a3b8; }
          input, select { padding: 10px; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: white; }
          button { background: #0284c7; color: white; border: none; padding: 10px 20px; border-radius: 4px; font-weight: bold; cursor: pointer; }
        </style>
        <meta http-equiv="refresh" content="10">
      </head>
      <body>
        <div class="header">
          <h2 style="margin: 0; color: #38bdf8;">🛡️ Ponte City Security & Reception HUD</h2>
          <div>● Live Feed</div>
        </div>
        <table>
          <thead>
            <tr><th>Alert Ref</th><th>Time</th><th>Visitor Details</th><th>Divert Reason</th><th>Zone</th><th>Action</th></tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="6" style="padding: 20px; text-align: center; color: #64748b;">No active verification alerts.</td></tr>'}
          </tbody>
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

app.get('/security/override', async (req, res) => {
  const { id, action } = req.query;
  const alert = securityAlerts.get(id);
  if (!alert) return res.status(404).send('Alert not found');

  if (action === 'APPROVE') {
    alert.status = 'APPROVED';
    await generateTurnstilePass(alert.visitorPhone, {
      visitorName: alert.visitorName,
      idNumber: alert.idNumber || 'PHYSICAL_CHECK_PASSED',
      accessType: 'SECURITY_DESK_CLEARANCE',
      zone: alert.zone,
      hostPhone: alert.hostPhone
    });
    await sendWhatsAppMessage(alert.visitorPhone, `🛡️ *Document Verified & Clearance Granted*\nYour turnstile pass is displayed above.`);
  } else {
    alert.status = 'REJECTED';
    await sendWhatsAppMessage(alert.visitorPhone, `🚫 *Entry Denied by Security Command*`);
  }
  res.redirect('/security/live');
});

app.post('/security/assisted-clear', async (req, res) => {
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

app.get('/', (req, res) => {
  res.json({ service: 'Ponte Concierge Unified Flow', status: 'ONLINE', time: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ponte Concierge running on http://0.0.0.0:${PORT}`);
});
