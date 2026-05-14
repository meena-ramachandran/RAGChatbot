import supabaseServer from '../../lib/supabaseServer';
import { getUserFromReq } from '../../lib/auth';

export default async function handler(req, res) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method === 'GET') {
    try {
      let data, error;

      try {
        const resp = await supabaseServer
          .from('documents')
          .select('id, file_name, storage_path, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        data = resp.data;
        error = resp.error;
        if (error) throw error;
      } catch {
        const resp2 = await supabaseServer
          .from('documents')
          .select('id, file_name, storage_path')
          .eq('user_id', user.id);

        data = resp2.data;
        error = resp2.error;
        if (error) throw error;
      }

      const docsWithUrls = await Promise.all((data || []).map(async (d) => {
        const out = { ...d };
        try {
          if (d.storage_path) {
            const { data: urlData } = await supabaseServer.storage
              .from('documents')
              .createSignedUrl(d.storage_path, 60);
            if (urlData?.signedUrl) out.signed_url = urlData.signedUrl;
          }
        } catch {
        }
        return out;
      }));

      return res.json({ documents: docsWithUrls });
    } catch (err) {
      console.error('Docs list error:', err);
      return res.status(500).json({ error: 'Failed to fetch documents' });
    }
  }

  if (req.method === 'DELETE') {
    const { documentId } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: 'Missing documentId' });
    }

    try {
      const { data: docs, error: fetchErr } = await supabaseServer
        .from('documents')
        .select('id, storage_path')
        .eq('id', documentId)
        .eq('user_id', user.id)
        .limit(1);

      if (fetchErr || !docs?.length) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const doc = docs[0];
      await supabaseServer
        .from('chunks')
        .delete()
        .eq('document_id', documentId);


      await supabaseServer
        .from('documents')
        .delete()
        .eq('id', documentId);


      if (doc.storage_path) {
        await supabaseServer.storage
          .from('documents')
          .remove([doc.storage_path]);
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('Delete doc error:', err);
      return res.status(500).json({ error: 'Failed to delete document' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
