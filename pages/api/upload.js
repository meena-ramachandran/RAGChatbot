import formidable from 'formidable';
import fs from 'fs';
import { createHash } from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

import { pipeline } from '@xenova/transformers';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

import supabaseServer from '../../lib/supabaseServer';
import { getUserFromReq } from '../../lib/auth';
import { processPdfText } from '../../lib/ingestionPipeline';

export const config = {
  api: { bodyParser: false },
};



const embedderPromise = pipeline(
  'feature-extraction',
  'Xenova/all-MiniLM-L6-v2'
);


function cleanText(text) {
  return text
    .replace(/\0/g, '')
    .replace(/[\u0001-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function parsePdf(buffer) {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const pdf = require('pdf-parse');
  const data = await pdf(buffer);

  return {
    text: data.text || '',
    numpages: data.numpages || 0,
  };
}



async function createQueue() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  const redisOptions = {
    connectTimeout: 2000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    tls: redisUrl.startsWith('rediss://') ? {} : undefined,
  };

  let connection;
  try {
    connection = new IORedis(redisUrl, redisOptions);

    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      connection.once('ready', () => {
        clearTimeout(t);
        resolve(true);
      });
      connection.once('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });

    if (!ok) {
      connection.disconnect();
      return null;
    }

    return {
      connection,
      queue: new Queue('pdf-processing', { connection }),
    };
  } catch {
    try { connection?.disconnect(); } catch { }
    return null;
  }
}


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = getUserFromReq(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const form = formidable({ multiples: true });

  await new Promise((resolve) => {
    form.parse(req, async (err, fields, files) => {
      try {
        if (err) {
          res.status(400).json({ error: err.message });
          return resolve();
        }

        const uploadedFiles = Array.isArray(files.file)
          ? files.file
          : [files.file];

        const results = [];

        for (const file of uploadedFiles) {
          try {
            const fileContent = fs.readFileSync(file.filepath);

            const hash = createHash('sha256')
              .update(fileContent)
              .digest('hex');

            const origName = file.originalFilename || 'upload.pdf';
            const ext = origName.match(/(\.[^.]+)$/)?.[1] || '';
            const storagePath = `uploads/${hash}${ext}`;

            /* ---------- Per-user dedup ---------- */

            const { data: existing } = await supabaseServer

              .from('documents')

              .select('id, document_name')

              .eq('file_hash', hash)

              .eq('user_id', user.id)

              .single();

            if (existing?.length) {
              results.push({
                fileName: origName,
                documentId: existing[0].id,
                storagePath,
                queued: false,
                note: 'Already uploaded by you',
              });
              continue;
            }


            const { data: storageData, error: storageError } =
              await supabaseServer.storage
                .from('documents')
                .upload(storagePath, fileContent, {
                  upsert: false,
                  contentType: 'application/pdf',
                });


            if (
              storageError &&
              !storageError.message?.toLowerCase().includes('already exists')
            ) {
              throw new Error(storageError.message);
            }

            const finalStoragePath =
              storageData?.path || storagePath;

            /* ---------- Insert document (per user) ---------- */

            const { error: insertErr } = await supabaseServer
              .from('documents')
              .insert({

                user_id:
                  user.id,

                document_name:
                  origName,

                source:
                  finalStoragePath,

                file_hash:
                  hash,

                document_type:
                  "technical_docs",

                security_level:
                  "internal",

                contains_pii:
                  false,

                total_chunks:
                  0,
              })

            if (insertErr) {
              throw new Error(insertErr.message);
            }


            const { data: document, error: fetchErr } =
              await supabaseServer
                .from('documents')
                .select('id, document_name')
                .eq('file_hash', hash)
                .eq('user_id', user.id)
                .single();
            if (fetchErr || !document) {
              throw new Error(
                'Failed to fetch inserted document'
              );
            }


            const qInfo = await createQueue();

            if (qInfo?.queue) {
              await qInfo.queue.add('pdf-job', {
                filePath: file.filepath,
                documentId: document.id,
                userId: user.id,
              });

              qInfo.connection.disconnect();
              results.push({
                fileName: origName,
                documentId: document.id,
                storagePath: finalStoragePath,
                queued: true,
              });
            } else {
              results.push({
                fileName: origName,
                documentId: document.id,
                storagePath: finalStoragePath,
                queued: false,
                note: 'Redis unavailable – inline processing',
              });


              (async () => {
                try {


                  const pdfData =await parsePdf(fileContent);

                  const enrichedChunks =await processPdfText({
                      text:pdfData.text,
                      documentId:document.id,
                      fileName:origName,
                      fileHash:hash,
                    });


                  const { error: chunkError } =
                    await supabaseServer
                      .from("document_chunks")
                      .insert(enrichedChunks);
                  if (chunkError) {
                    throw chunkError;
                  }
                } catch (e) {
                  console.error('Inline processing failed:', e);
                }
              })();
            }
          } catch (fileErr) {
            results.push({
              fileName: file.originalFilename,
              error: fileErr.message,
            });
          }
        }

        res.status(200).json({ success: true, files: results });
        resolve();
      } catch (fatal) {
        console.error('Upload API fatal error:', fatal);
        if (!res.headersSent) {
          res.status(500).json({ error: fatal.message || 'Upload failed' });
        }
        resolve();
      }
    });
  });
}
