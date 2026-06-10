import fs from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'mock_supabase_db.json');
const STORAGE_DIR = path.join(process.cwd(), 'mock_storage');

// Helper to read/write persistent mock database
function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: [], documents: [], document_chunks: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: [], documents: [], document_chunks: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Ensure the storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

class SupabaseQueryBuilder {
  constructor(tableName) {
    this.tableName = tableName;
    this.filters = [];
    this.insertData = null;
    this.selectColumns = '*';
    this.isSingle = false;
    this.isDelete = false;
  }

  select(columns = '*') {
    this.selectColumns = columns;
    return this;
  }

  insert(data) {
    this.insertData = data;
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  delete() {
    this.isDelete = true;
    return this;
  }

  // Support thenable so it can be awaited directly
  async then(resolve, reject) {
    try {
      const db = readDB();
      if (!db[this.tableName]) {
        db[this.tableName] = [];
      }

      let data = null;
      let error = null;

      if (this.insertData) {
        // Handle insert
        const items = Array.isArray(this.insertData) ? this.insertData : [this.insertData];
        const newItems = items.map(item => {
          const newItem = { ...item };
          if (!newItem.id) {
            newItem.id = 'sub_' + Math.random().toString(36).substr(2, 9);
          }
          if (!newItem.created_at) {
            newItem.created_at = new Date().toISOString();
          }
          if (this.tableName === 'users' && newItem.is_active === undefined) {
            newItem.is_active = true;
          }
          db[this.tableName].push(newItem);
          return newItem;
        });
        writeDB(db);
        data = Array.isArray(this.insertData) ? newItems : newItems[0];
      } else if (this.isDelete) {
        // Handle delete
        const originalLength = db[this.tableName].length;
        db[this.tableName] = db[this.tableName].filter(item => {
          for (const f of this.filters) {
            if (item[f.column] !== f.value) return true;
          }
          return false;
        });
        writeDB(db);
        data = { count: originalLength - db[this.tableName].length };
      } else {
        // Handle select
        let list = db[this.tableName];
        list = list.filter(item => {
          for (const f of this.filters) {
            if (item[f.column] !== f.value) return false;
          }
          return true;
        });

        if (this.isSingle) {
          data = list.length > 0 ? list[0] : null;
        } else {
          data = list;
        }
      }

      const result = { data, error };
      return resolve ? resolve(result) : result;
    } catch (err) {
      return reject ? reject(err) : Promise.reject(err);
    }
  }
}

const supabaseServer = {
  from(tableName) {
    return new SupabaseQueryBuilder(tableName);
  },
  storage: {
    from(bucketName) {
      const bucketDir = path.join(STORAGE_DIR, bucketName);
      if (!fs.existsSync(bucketDir)) {
        fs.mkdirSync(bucketDir, { recursive: true });
      }

      return {
        async upload(storagePath, fileContent, options = {}) {
          try {
            const destPath = path.join(bucketDir, storagePath);
            const parentDir = path.dirname(destPath);
            if (!fs.existsSync(parentDir)) {
              fs.mkdirSync(parentDir, { recursive: true });
            }
            fs.writeFileSync(destPath, fileContent);
            return { data: { path: storagePath }, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        },
        async download(storagePath) {
          try {
            const srcPath = path.join(bucketDir, storagePath);
            if (!fs.existsSync(srcPath)) {
              return { data: null, error: new Error('File not found') };
            }
            const buffer = fs.readFileSync(srcPath);
            return { data: buffer, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        },
        async createSignedUrl(storagePath, expiresIn) {
          // Just return public url mockup
          const publicUrl = `/api/mock_storage/${bucketName}/${storagePath}`;
          return { data: { signedUrl: publicUrl }, error: null };
        },
        async list(prefix) {
          try {
            const searchDir = prefix ? path.join(bucketDir, prefix) : bucketDir;
            if (!fs.existsSync(searchDir)) {
              return { data: [], error: null };
            }
            const files = fs.readdirSync(searchDir);
            const list = files.map(file => {
              const stat = fs.statSync(path.join(searchDir, file));
              return {
                name: file,
                id: file,
                metadata: {
                  size: stat.size,
                  mimetype: file.endsWith('.pdf') ? 'application/pdf' : 'text/plain'
                }
              };
            });
            return { data: list, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        },
        async remove(paths) {
          try {
            for (const p of paths) {
              const target = path.join(bucketDir, p);
              if (fs.existsSync(target)) {
                fs.unlinkSync(target);
              }
            }
            return { data: {}, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        }
      };
    }
  }
};

export default supabaseServer;
