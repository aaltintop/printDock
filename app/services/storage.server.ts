import { storage } from "../firebase.server";

// Generate a presigned URL for the browser to upload directly to Firebase Storage
export async function getPresignedUploadUrl(
  shopDomain: string,
  sessionId: string,
  fileName: string,
  mimeType: string
): Promise<{ presignedUrl: string; storagePath: string }> {
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  const suffix = ext && ext.length <= 32 ? ext : "bin";
  const storagePath = `uploads/${shopDomain}/${sessionId}/${Date.now()}.${suffix}`;

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  const contentType =
    mimeType && mimeType.trim() !== "" ? mimeType.trim() : "application/octet-stream";

  const [presignedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 5 * 60 * 1000, // 5 minutes
    contentType,
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

/** Signed read URL that asks the browser to download (not inline-open). */
export async function getSignedDownloadUrlAttachment(
  storagePath: string,
  downloadFileName: string,
  expiresInSeconds = 600,
): Promise<string> {
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const safe =
    downloadFileName.replace(/[\r\n"]/g, "_").slice(0, 200) || "download";

  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + expiresInSeconds * 1000,
    queryParams: {
      "response-content-disposition": `attachment; filename="${safe}"`,
    },
  });

  return url;
}

export async function fileExists(storagePath: string): Promise<boolean> {
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  return exists;
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

/** Delete every object whose name starts with prefix (e.g. uploads/shop.example.com/). */
export async function deleteStorageByPrefix(prefix: string): Promise<number> {
  const bucket = storage.bucket();
  const [files] = await bucket.getFiles({ prefix });
  await Promise.all(
    files.map((f) => f.delete({ ignoreNotFound: true })),
  );
  return files.length;
}

// Copy a file to another path in the same bucket.
export async function copyFile(sourcePath: string, targetPath: string): Promise<void> {
  const bucket = storage.bucket();
  const sourceFile = bucket.file(sourcePath);
  const targetFile = bucket.file(targetPath);
  await sourceFile.copy(targetFile);
}
