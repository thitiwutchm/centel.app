import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Railway buckets are S3-compatible; the service gets these variables from the bucket.
const bucket = process.env.BUCKET || process.env.S3_BUCKET;
const s3 = bucket
  ? new S3Client({
    endpoint: process.env.ENDPOINT || process.env.S3_ENDPOINT,
    region: process.env.REGION || process.env.S3_REGION || 'auto',
    credentials: {
      accessKeyId: process.env.ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  })
  : null;

export const storageEnabled = !!s3;

const disabled = () => Object.assign(new Error('storage_disabled'), { status: 503, expose: true });

export async function putReceipt(key, body, contentType) {
  if (!s3) throw disabled();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// Short-lived link so receipts never sit at a public URL.
export async function receiptUrl(key) {
  if (!s3) throw disabled();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

// Bill invoice files are streamed through the API (same origin, so no bucket CORS needed).
export async function getObject(key) {
  if (!s3) throw disabled();
  try {
    return await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function deleteObject(key) {
  if (!s3) throw disabled();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
