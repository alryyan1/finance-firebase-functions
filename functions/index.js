const { onRequest } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const logger = require('firebase-functions/logger')
const admin = require('firebase-admin')
const crypto = require('node:crypto')

admin.initializeApp()
const db = admin.firestore()

const META_VERIFY_TOKEN = defineSecret('META_VERIFY_TOKEN')
const WHATSAPP_TOKEN = defineSecret('WHATSAPP_TOKEN')
const WHATSAPP_PHONE_NUMBER_ID = defineSecret('WHATSAPP_PHONE_NUMBER_ID')

// Keep in sync with WHATSAPP_API_VERSION in finance-api/.env — not a secret,
// just the Graph API version both sides target.
const WHATSAPP_API_VERSION = 'v25.0'

// Keep in sync with FIREBASE_STORAGE_BUCKET in finance-api/.env — the bucket
// Laravel's FirebaseStorageService uploads receipts to.
const STORAGE_BUCKET = 'sales-9e9b8.firebasestorage.app'

const ACTION_APPROVE = 'petty_cash_approvals'
const ACTION_VIEW_DOCUMENT = 'petty_cash_documents'
const ACTION_ATTACH = 'petty_cash_attach'

const PENDING_ATTACHMENT_TTL_MS = 10 * 60 * 1000

/**
 * Webhook for Meta's WhatsApp Cloud API. Handles the GET verification handshake,
 * and on POST, reacts to three kinds of inbound messages. Laravel is never
 * called from here — this function is fully self-contained:
 *  - Quick-reply button taps ("{action}:{collectionName}:{transactionId}:{role}"):
 *    - petty_cash_approvals: mirrors the approval into Firestore under
 *      finance/{collectionName}/petty_cash_approvals. Laravel later reconciles
 *      MySQL against this the next time anyone opens the Petty Cash page.
 *    - petty_cash_documents: reads document_url/document_type straight off that
 *      same Firestore doc (live, not from the button) and sends it directly to
 *      WhatsApp by link — Meta fetches public URLs itself.
 *  - A bare image/PDF from a configured manager/auditor number: cached as a
 *    "pending attachment" for that phone, then answered with a list message of
 *    that company's pending expenses to pick from (see ACTION_ATTACH below).
 *  - The list reply to that picker ("petty_cash_attach:{collectionName}:{id}"):
 *    downloads the previously-cached media from Meta, uploads it straight to
 *    Firebase Storage, and writes document_url/document_type onto that
 *    transaction's mirror doc — then confirms back over WhatsApp.
 */
exports.pettyCashWebhook = onRequest(
  { secrets: [META_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID] },
  async (req, res) => {
    if (req.method === 'GET') {
      return handleVerification(req, res)
    }

    if (req.method === 'POST') {
      await handleIncoming(req)
      // Meta requires a fast 200 regardless of internal outcome, or it will retry
      // (and eventually disable) the webhook — errors above are logged, not surfaced.
      return res.sendStatus(200)
    }

    return res.sendStatus(405)
  },
)

function handleVerification(req, res) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN.value()) {
    return res.status(200).send(challenge)
  }

  return res.sendStatus(403)
}

async function handleIncoming(req) {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value
    const message = value?.messages?.[0]
    if (!message) {
      return
    }

    const fromPhone = message.from

    if (message.type === 'image' || message.type === 'document') {
      await handleIncomingReceipt(message, fromPhone)
      return
    }

    const listReplyId = message.interactive?.list_reply?.id
    if (listReplyId?.startsWith(`${ACTION_ATTACH}:`)) {
      await handleTransactionPicked(listReplyId, fromPhone)
      return
    }

    const payload = message.button?.payload ?? message.interactive?.button_reply?.id
    if (!payload) {
      return
    }

    const [action, collectionName, transactionId, role] = payload.split(':')
    if (![ACTION_APPROVE, ACTION_VIEW_DOCUMENT].includes(action) || !collectionName || !transactionId || !role) {
      logger.warn('Ignoring unrecognized WhatsApp button payload', { payload })
      return
    }

    const docRef = db.collection('finance').doc(collectionName).collection('petty_cash_approvals').doc(transactionId)

    if (action === ACTION_APPROVE) {
      await docRef.set(
        {
          [`${role}_approved`]: true,
          [`${role}_approved_at`]: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      return
    }

    await sendDocumentLink(docRef, fromPhone)
  } catch (err) {
    logger.error('petty cash webhook error', err)
  }
}

/**
 * Answers the "عرض المستند" tap by reading document_url/document_type straight
 * off the Firestore mirror doc — live, not from the button's payload — so a
 * receipt attached after the original WhatsApp notification was sent still
 * works when that already-delivered message's button is tapped.
 */
async function sendDocumentLink(docRef, toPhone) {
  if (!toPhone) {
    return
  }

  const snapshot = await docRef.get()
  const data = snapshot.data()
  const documentUrl = data?.document_url

  if (!documentUrl) {
    logger.info('No document attached to this transaction — skipping', { path: docRef.path })
    return
  }

  const isImage = data?.document_type === 'image'
  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID.value()}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_TOKEN.value()}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: isImage ? 'image' : 'document',
        [isImage ? 'image' : 'document']: { link: documentUrl },
      }),
    },
  )

  if (!response.ok) {
    logger.error('Failed to send document link via WhatsApp', {
      status: response.status,
      body: await response.text(),
    })
  }
}

/**
 * A photo or PDF sent by a recognized manager/auditor number, not tied to any
 * particular transaction yet. Cache it against their phone number and ask them
 * which pending expense it belongs to via a WhatsApp list message.
 */
async function handleIncomingReceipt(message, fromPhone) {
  const sender = await lookupSender(fromPhone)
  if (!sender) {
    // Unrecognized number — this webhook may also see unrelated traffic, so stay silent.
    return
  }

  const media = message.type === 'image' ? message.image : message.document
  if (!media?.id) {
    return
  }

  await db.collection('whatsapp_pending_attachments').doc(fromPhone).set({
    mediaId: media.id,
    mediaType: message.type,
    collectionName: sender.collectionName,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })

  const rows = await listPendingExpenseRows(sender.collectionName)
  if (rows.length === 0) {
    await sendText(fromPhone, 'لا توجد مصروفات بانتظار الاعتماد لإرفاق المستند بها حالياً.')
    return
  }

  await sendTransactionPickerList(fromPhone, rows)
}

/**
 * Looks up whether a phone number is the configured petty-cash manager/auditor,
 * and which finance/{collectionName} it belongs to — mirrored into Firestore by
 * Laravel's FirestoreApprovalService::syncWhatsAppSenderConfig() whenever
 * Settings > Petty Cash is saved. Returns null for anyone else.
 */
async function lookupSender(phone) {
  const snapshot = await db.collection('whatsapp_petty_cash_senders').doc(phone).get()
  const data = snapshot.data()
  if (!data?.collection_name) {
    return null
  }

  return { role: data.role, collectionName: data.collection_name }
}

/**
 * Up to 10 most-recent not-yet-manager-approved expenses for the list picker.
 * Filters client-side rather than with a Firestore where()+orderBy() on
 * different fields, which would need a composite index.
 */
async function listPendingExpenseRows(collectionName) {
  const snapshot = await db
    .collection('finance').doc(collectionName).collection('petty_cash_approvals')
    .orderBy('created_at', 'desc')
    .limit(25)
    .get()

  return snapshot.docs
    .filter(doc => doc.data()?.manager_approved !== true)
    .slice(0, 10)
    .map(doc => {
      const data = doc.data()
      const amount = typeof data.amount === 'number' ? data.amount.toLocaleString('en-US') : String(data.amount ?? '')
      const label = data.description || data.beneficiary_name || 'مصروف نثرية'

      return {
        id: `${ACTION_ATTACH}:${collectionName}:${doc.id}`,
        title: truncate(`#${doc.id} — ${amount}`, 24),
        description: truncate(label, 72),
      }
    })
}

function truncate(text, max) {
  const s = String(text)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

async function sendTransactionPickerList(toPhone, rows) {
  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID.value()}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_TOKEN.value()}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: 'إرفاق المستند' },
          body: { text: 'اختر الحركة التي تريد إرفاق المستند بها:' },
          action: {
            button: 'اختيار الحركة',
            sections: [{ title: 'مصروفات بانتظار الاعتماد', rows }],
          },
        },
      }),
    },
  )

  if (!response.ok) {
    logger.error('Failed to send petty cash transaction picker list', {
      status: response.status,
      body: await response.text(),
    })
  }
}

/**
 * The sender tapped a row in the picker list — attach whichever media they sent
 * just before that (cached in whatsapp_pending_attachments) to that transaction.
 */
async function handleTransactionPicked(listReplyId, fromPhone) {
  const [, collectionName, transactionId] = listReplyId.split(':')
  if (!collectionName || !transactionId) {
    return
  }

  const pendingRef = db.collection('whatsapp_pending_attachments').doc(fromPhone)
  const pendingSnap = await pendingRef.get()
  const pending = pendingSnap.data()

  if (!pending?.mediaId) {
    await sendText(fromPhone, 'لم يتم العثور على صورة أو ملف بانتظار الإرفاق. أرسل الصورة أو الملف أولاً ثم اختر الحركة.')
    return
  }

  const createdAtMs = pending.createdAt?.toMillis?.() ?? 0
  if (Date.now() - createdAtMs > PENDING_ATTACHMENT_TTL_MS) {
    await pendingRef.delete()
    await sendText(fromPhone, 'انتهت صلاحية الملف المرسل. الرجاء إرساله مرة أخرى.')
    return
  }

  try {
    const { buffer, contentType } = await downloadWhatsAppMedia(pending.mediaId)
    const documentType = pending.mediaType === 'image' ? 'image' : 'document'
    const ext = documentType === 'image' ? 'jpg' : 'pdf'
    const objectName = `petty-cash-receipts/${transactionId}-whatsapp-${Date.now()}.${ext}`
    const documentUrl = await uploadToFirebaseStorage(objectName, buffer, contentType)

    const docRef = db.collection('finance').doc(collectionName).collection('petty_cash_approvals').doc(transactionId)
    await docRef.set({ document_url: documentUrl, document_type: documentType }, { merge: true })

    await pendingRef.delete()
    await sendText(fromPhone, `تم إرفاق المستند بنجاح بالحركة رقم ${transactionId}.`)
  } catch (err) {
    logger.error('Failed to attach WhatsApp receipt to petty cash transaction', err)
    await sendText(fromPhone, 'تعذّر إرفاق المستند، الرجاء المحاولة مرة أخرى.')
  }
}

/** Resolves a WhatsApp media id to its bytes — a two-step lookup per Meta's Media API. */
async function downloadWhatsAppMedia(mediaId) {
  const metaResponse = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN.value()}` } },
  )
  if (!metaResponse.ok) {
    throw new Error(`Failed to look up WhatsApp media ${mediaId}: ${metaResponse.status}`)
  }
  const meta = await metaResponse.json()

  const fileResponse = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN.value()}` } })
  if (!fileResponse.ok) {
    throw new Error(`Failed to download WhatsApp media ${mediaId}: ${fileResponse.status}`)
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer())
  return { buffer, contentType: meta.mime_type || fileResponse.headers.get('content-type') || 'application/octet-stream' }
}

/**
 * Uploads straight to the same bucket/URL shape Laravel's FirebaseStorageService
 * produces, so the reconcileFromFirestore() download-back-into-local-storage
 * path on the Laravel side works unchanged regardless of which side uploaded it.
 */
async function uploadToFirebaseStorage(objectName, buffer, contentType) {
  const bucket = admin.storage().bucket(STORAGE_BUCKET)
  const file = bucket.file(objectName)
  const token = crypto.randomUUID()

  await file.save(buffer, {
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  })

  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(objectName)}?alt=media&token=${token}`
}

async function sendText(toPhone, body) {
  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID.value()}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_TOKEN.value()}`,
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body } }),
    },
  )

  if (!response.ok) {
    logger.error('Failed to send WhatsApp text message', {
      status: response.status,
      body: await response.text(),
    })
  }
}
