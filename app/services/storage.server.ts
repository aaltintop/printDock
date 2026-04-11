import { storage } from "../firebase.server";

// Generate a presigned URL for the browser to upload directly to Firebase Storage
export async function getPresignedUploadUrl(
  shopDomain: string,
  sessionId: string,
  fileName: string,
  mimeType: string
): Promise<{ presignedUrl: string; storagePath: string }> {
  const ext = fileName.split(".").pop();
  const storagePath = `uploads/${shopDomain}/${sessionId}/${Date.now()}.${ext}`;

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  const [presignedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 5 * 60 * 1000, // 5 minutes
    contentType: mimeType,
  });

  return { presignedUrl, storagePath };
}

// Generate a time-limited signed URL for merchant to download a file
export async function getSignedDownloadUrl(
  storagePath: string,
  expiresInSeconds = 3600 // 1 hour default
): Promise<string> {
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + expiresInSeconds * 1000,
  });

  return url;
}

// Get file as Buffer — used only server-side for validation
export async function getFileBuffer(storagePath: string): Promise<Buffer> {
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const [buffer] = await file.download();
  return buffer;
}

// Delete a file from Storage
export async function deleteFile(storagePath: string): Promise<void> {
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  await file.delete({ ignoreNotFound: true });
}

// Copy a file to another path in the same bucket.
export async function copyFile(sourcePath: string, targetPath: string): Promise<void> {
  const bucket = storage.bucket();
  const sourceFile = bucket.file(sourcePath);
  const targetFile = bucket.file(targetPath);
  await sourceFile.copy(targetFile);
}
