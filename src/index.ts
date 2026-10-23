import { MultiZipReader, PathTreeNode, createStreamFromOffset, parseZipDataOffset } from '@fparchive/multi-zip-reader';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { create } from 'express-handlebars';
import fs, { readdirSync } from 'fs';
import { FileHandle } from 'fs/promises';
import mime from 'mime';
import { Collection, Db, MongoClient } from 'mongodb';
import path from 'path';

const serverPrefix = process.env.SERVER_PREFIX || '';

interface FileDocument {
  _id?: string;
  name: string;
  parent: string;
  archivePath: string;
  crc32: number;
  offset: number;
  compressedLength: number;
  compressionMethod: number; // 0 - Store, 8 - Deflate
  length: number;
}

interface DirectoryDocument {
  _id?: string;
  name: string;
  archivePath: string;
  parent: string;
}


interface SourceDocument {
  _id?: string;
  archivePath: string;
  size: number;
  fileCount: number;
}

dotenv.config({ path: './.env' });

const app = express()
const port = process.env.PORT || '3000';

let db: Db;
let filesCollection: Collection<FileDocument>;
let directoryCollection: Collection<DirectoryDocument>;
let sourcesCollection: Collection<SourceDocument>;
let fpfssUrl = process.env.FPFSS_URL;

if (fpfssUrl && fpfssUrl.endsWith('/')) {
  fpfssUrl = fpfssUrl.slice(0, -1);
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const dirIgnore = [
  "Flashpoint Ultimate",
  "Flashpoint Ultimate/Legacy",
  "Flashpoint Ultimate/Legacy/htdocs",
  "content"
];
const matcherRemovals = ["Flashpoint Ultimate/Legacy/htdocs/", "content/"];

function fixName(filePath: string) {
  for (const matcher of matcherRemovals) {
    if (filePath.startsWith(matcher)) {
      return filePath.slice(matcher.length)
    }
  }
  return filePath;
}

function countNode(node: PathTreeNode): number {
  let total = 0;
  if (node.files) {
    total += node.files.size;
  }
  if (node.children) {
    for (const [path, child] of node.children) {
      total += countNode(child)
    }
  }
  return total;
}

function getFilePath(req: Request): string {
  let filePath = req.params['filePath'];
  if (!filePath) {
    return '';
  }
  if (typeof filePath === 'string') {
    return filePath;
  } else {
    return (filePath as any as string[]).join('/');
  }
}

function splitNameAndParent(filePath: string): [string, string] {
  filePath = fixName(filePath);
  const parts = filePath.split('/');
  const partName = parts.at(-1)!;
  const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  return [partName, parent];
}

async function storePathTreeInMongo(
  fd: FileHandle,
  node: PathTreeNode,
  archivePath: string,
  currentPath: string[] = [],
): Promise<void> {
  const documents: FileDocument[] = [];
  const dirDocuments: DirectoryDocument[] = [];

  async function traverse(n: PathTreeNode, path: string[]) {
    if (n.files && n.files.size > 0) {
      for (const [_, fileInfo] of n.files) {
        const { name, compressedLength, compressionMethod, length, crc32, offset } = await parseZipDataOffset(fd, archivePath, fileInfo);
        if (name === 'content.json') {
          // Ignore top level content.json
          continue;
        }
        const [partName, parent] = splitNameAndParent(name);
        documents.push({
          name: partName,
          parent: parent,
          archivePath,
          compressedLength,
          compressionMethod,
          length,
          offset,
          crc32,
        });
      }
    }

    if (n.children && n.children.size > 0) {
      const dirPath = path.join('/');
      if (!dirIgnore.includes(dirPath)) {
        // Don't create directories for cut down paths
        const [partName, parent] = splitNameAndParent(dirPath);
        // Ignore root directory
        if (path.length > 0) {
          dirDocuments.push({
            name: partName,
            parent,
            archivePath,
          });
        }
        
      }
      for (const [segment, child] of n.children) {
        await traverse(child, [...path, segment]);
      }
    }
  }

  await traverse(node, currentPath);

  if (documents.length > 0) {
    await filesCollection.insertMany(documents, { ordered: false })
      .catch(err => {
        if (err.code !== 11000) throw err;
      });
  }

  if (dirDocuments.length > 0) {
    await directoryCollection.insertMany(dirDocuments, { ordered: false })
      .catch(err => {
        if (err.code !== 11000) throw err;
      });
  }
}

async function doParse() {
  if (!process.env.DIRECTORIES) {
    console.log('Env DIRECTORIES must be defined');
    return;
  }
  
  if (!process.env.MONGO_URL) {
    console.log('Env MONGO_URL must be defined');
    return;
  }

  const forceReindex = process.env.FORCE_REINDEX === 'true';

  // Build MongoDB connection string with authentication
  let mongoUrl = process.env.MONGO_URL;

  if (process.env.MONGO_PASSWORD) {
    const username = process.env.MONGO_USERNAME || 'admin';
    const password = encodeURIComponent(process.env.MONGO_PASSWORD);
    
    // Parse the URL to inject credentials
    const url = new URL(mongoUrl);
    url.username = username;
    url.password = password;
    mongoUrl = url.toString();
  }

  const client = new MongoClient(mongoUrl);
  await client.connect();
  db = client.db(process.env.MONGO_DB || 'ziparchive');
  filesCollection = db.collection('files');
  directoryCollection = db.collection('directories');
  sourcesCollection = db.collection('sources');

  if (forceReindex) {
    console.log('Clearing existing collections...');
    await filesCollection.dropIndexes({});
    await filesCollection.deleteMany({});
    await directoryCollection.deleteMany({});
    await directoryCollection.dropIndexes({});
    await sourcesCollection.deleteMany({});
    await sourcesCollection.dropIndexes({});
    console.log('Collections cleared');
  }

  // Create indexes
  await filesCollection.createIndex(
    { parent: 1, name: 1, archivePath: 1 }, 
    { unique: true }
  );
  await directoryCollection.createIndex(
    { parent: 1, name: 1, archivePath: 1 }, 
    { unique: true }
  );
  await filesCollection.createIndex(
    { parent: 1, archivePath: 1, name: 1 },
    { unique: true }
  );
  await directoryCollection.createIndex(
    { parent: 1, archivePath: 1, name: 1 }, 
    { unique: true }
  );
  await filesCollection.createIndex({ archivePath: 1 });
  await directoryCollection.createIndex({ archivePath: 1 });
  await sourcesCollection.createIndex({ archivePath: 1 }, { unique: true });
  
  console.log('Connected to MongoDB');

  const existingSources = await sourcesCollection.find({}, { projection: { archivePath: 1 } }).toArray();
  const indexedArchives = new Set(existingSources.map(s => s.archivePath));
  console.log(`Found ${indexedArchives.size} already indexed archives`);

  const directories = JSON.parse(process.env.DIRECTORIES || '[]');
  let totalFiles = 0;

  console.log('Loading directories:');
  for (const directory of directories) {
    console.log(directory);
    for (const file of readdirSync(directory).filter(f => f.endsWith('.zip'))) {
      const fullPath = path.join(directory, file);

      if (indexedArchives.has(fullPath)) {
        continue;
      }

      console.log('Parsing ' + fullPath);

      const reader = new MultiZipReader();
      const stats = fs.statSync(fullPath);
      try {
        await reader.loadArchive(fullPath);
      } catch (err) {
        console.log(err);
        continue;
      }
      const total = countNode(reader.pathTree);
      const fd = await fs.promises.open(fullPath, 'r');

      await filesCollection.deleteMany({ archivePath: fullPath });
      await directoryCollection.deleteMany({ archivePath: fullPath });

      try {
        totalFiles += total;

        // Store file docs
        await storePathTreeInMongo(fd, reader.pathTree, fullPath);
        const sourceDoc: SourceDocument = {
          archivePath: fullPath,
          size: stats.size,
          fileCount: total
        };
        await sourcesCollection.insertOne(sourceDoc);
      } finally {
        fd.close();
      }
    }
  }
  console.log(`Indexed New Files: ${totalFiles}`);
}

type DirInfo = {
  path: string;
  directories: string[];
  files: string[];
}

type FileInfo = {
  archivePath: string;
  length: number;
  crc32: number;
}

async function getDirInfo(dirPath: string, archivePath?: string): Promise<DirInfo | null> {
  if (dirPath.endsWith('/')) {
    dirPath = dirPath.slice(0, -1);
  }

  // Find all files that match the directory path
  const query: Record<string, any> = {
    parent: dirPath 
  };
  if (archivePath) {
    query.archivePath = archivePath;
  }
  const files = await filesCollection.find(query, {
    projection: { name: 1, _id: 0 }
  }).toArray();
  const dirs = await directoryCollection.find(query, {
    projection: { name: 1, _id: 0 }
  }).toArray();

  // Categorize children as files or directories
  const fileEntries = new Set<string>();
  const directories = new Set<string>();

  for (const f of files) {
    fileEntries.add(f.name);
  }

  for (const d of dirs) {
    directories.add(d.name);
  }

  const data = {
    path: dirPath,
    directories: Array.from(directories),
    files: Array.from(fileEntries),
  };

  if (data.directories.length === 0 && data.files.length === 0) {
    return null;
  }

  return data;
}

async function getFileInfo(filePath: string): Promise<FileInfo[] | null> {
  const [partName, parent] = splitNameAndParent(filePath);
  const fileDocs = await filesCollection.find({ name: partName, parent }).toArray();
  if (fileDocs.length === 0) {
    return null;
  }
  return fileDocs.map(f => {
    return {
      archivePath: f.archivePath,
      length: f.length,
      crc32: f.crc32
    } satisfies FileInfo;
  })
}

async function handleBrowser(req: Request, res: Response) {
  let dirPath = getFilePath(req);
  const encodedArchive = req.query.archive as string | undefined;
  let archivePath: string | undefined;
  
  // Decode archive path if provided
  if (encodedArchive) {
    try {
      archivePath = Buffer.from(encodedArchive, 'base64url').toString('utf-8');
    } catch (err) {
      return res.status(400).send('<h1>Invalid archive parameter</h1>');
    }
  }
  
  try {
    const dirInfo = await getDirInfo(dirPath, archivePath);

    if (dirInfo === null) {
      return res.status(404).send('<h1>Directory not found</h1>');
    }

    // Build breadcrumbs
    const breadcrumbs = dirPath ? dirPath.split('/').map((part, idx, arr) => ({
      name: part,
      path: arr.slice(0, idx + 1).join('/')
    })) : [];

    // Prepare template data
    const data = {
      prefix: serverPrefix,
      dirPath: dirPath || '/',
      breadcrumbs,
      hasParent: dirPath !== '',
      parentPath: dirPath.split('/').slice(0, -1).join('/'),
      directories: dirInfo.directories.map(name => ({
        name,
        path: dirPath ? `${dirPath}/${name}` : name
      })),
      files: dirInfo.files.map(name => ({
        name,
        path: dirPath ? `${dirPath}/${name}` : name
      })),
      archivePath,
      encodedArchive,
      dirCount: dirInfo.directories.length,
      fileCount: dirInfo.files.length,
      dirPlural: dirInfo.directories.length !== 1,
      filePlural: dirInfo.files.length !== 1
    };

    res.render('browse', data);
  } catch (err) {
    console.error('Browse error:', err);
    res.status(500).send('<h1>Error browsing directory</h1>');
  }
}

async function main() {
  console.log('Initializing zip reader...');

  doParse();

  const hbs = create({
    extname: '.hbs',
    defaultLayout: false,
    helpers: {
      formatBytes: (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
      },
      formatCRC32: (crc32: number) => {
        return '0x' + crc32.toString(16).toUpperCase().padStart(8, '0');
      },
      encodeURIComponent: (str: string) => {
        return encodeURIComponent(str);
      },
      encodeArchivePath: (archivePath: string) => {
        return Buffer.from(archivePath, 'utf-8').toString('base64url');
      },
      getGameIdFromFilename: (filePath: string) => {
        const [partName] = splitNameAndParent(filePath);
        if (partName.length > 36) {
          const uuid = partName.slice(0, 36);

          if (uuidRegex.test(uuid)) {
            return uuid;
          }
        }
      }
    }
  });

  app.engine('hbs', hbs.engine);
  app.set('view engine', 'hbs');

  app.get('/', (req, res) => {
    res.send('Multi Zip Reader Server');
  })

  app.get('/browse', handleBrowser);

  app.get('/browse/{*filePath}', handleBrowser);

  app.get('/file/{*filePath}', async (req, res) => {
    const filePath = getFilePath(req);

    try {
      const fileInfo = await getFileInfo(filePath);

      if (fileInfo === null) {
        return res.status(404).send('<h1>File not found</h1>');
      }

      const [partName, parent] = splitNameAndParent(filePath);

      // Build breadcrumbs
      const breadcrumbs = filePath ? filePath.split('/').slice(0, -1).map((part, idx, arr) => ({
        name: part,
        path: arr.slice(0, idx + 1).join('/')
      })) : [];

      const data = {
        prefix: serverPrefix,
        breadcrumbs,
        filePath,
        filename: partName,
        files: fileInfo,
        fpfssUrl,
        fileCount: fileInfo.length,
      };

      return res.render('file', data);
    } catch (err) {
      console.error('List error:', err);
      return res.status(500).send('<h1>Error listing files</h1>');
    }
  })

  app.get('/api/list/{*filePath}', async (req, res) => {
    let dirPath = getFilePath(req);
    const encodedArchive = req.query.archive as string | undefined;
    let archivePath: string | undefined;
    
    // Decode archive path if provided
    if (encodedArchive) {
      try {
        archivePath = Buffer.from(encodedArchive, 'base64url').toString('utf-8');
      } catch (err) {
        return res.status(400).json({ error: 'Invalid archive parameter' });
      }
    }
  
    try {
      const dirInfo = await getDirInfo(dirPath, archivePath);

      if (dirInfo === null) {
        return res.status(404).json({ error: 'Directory not found' });
      }

      return res.json(dirInfo);
    } catch (err) {
      console.error('List error:', err);
      res.status(500).json({ error: 'Error listing directory' });
    }
  });
  

  app.get('/api/info/{*filePath}', async (req, res) => {
    const filePath = getFilePath(req);

    try {
      const fileInfo = await getFileInfo(filePath);

      if (fileInfo === null) {
        return res.status(404).json({ error: 'File not found' });
      }

      return res.json({
        files: fileInfo
      });
    } catch (err) {
      console.error('List error:', err);
      res.status(500).json({ error: 'Error listing files' });
    }
  })

  app.get('/api/stats', async (req, res) => {
    const totalFiles = await filesCollection.countDocuments();
    const totalDirectories = await directoryCollection.countDocuments();
    const totalSources = await sourcesCollection.countDocuments();

    return res.json({
      "files": totalFiles,
      "directories": totalDirectories,
      "sources": totalSources,
    })
  });

  app.get('/api/archive/:encodedArchive/download', async (req, res) => {
    const encodedArchive = (req.params as any).encodedArchive as string;
    try {
      const archivePath = Buffer.from(encodedArchive, 'base64url').toString('utf-8');
      const source = await sourcesCollection.findOne({ archivePath });
      if (source !== null) {
        const [partName, parent] = splitNameAndParent(archivePath);
        res.setHeader('Content-Disposition', `attachment; filename="${partName}"`);

        res.sendFile(archivePath);
      } else {
        res.status(404).json({ error: 'Archive not found' });
      }
    } catch (err) {
      console.error('Download error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/archive/:encodedArchive/download/{*filePath}', async (req, res) => {
    const filePath = getFilePath(req);
    const encodedArchive = (req.params as any).encodedArchive as string;
    const [partName, parent] = splitNameAndParent(filePath);

    try {
      const archivePath = Buffer.from(encodedArchive, 'base64url').toString('utf-8');
      // Find file from specific archive
      const fileDoc = await filesCollection.findOne({ 
        name: partName, 
        parent,
        archivePath
      });
      
      if (!fileDoc) {
        return res.status(404).json({ error: 'File not found in specified archive' });
      }
      
      if (fileDoc.length === 0) {
        return res.status(204).send();
      }
  
      const stream = await createStreamFromOffset({
        name: fileDoc.name,
        filePath: fileDoc.archivePath,
        crc32: fileDoc.crc32,
        offset: fileDoc.offset,
        length: fileDoc.length,
        compressedLength: fileDoc.compressedLength,
        compressionMethod: fileDoc.compressionMethod
      });
  
      if (stream === null) {
        return res.status(404).json({ error: 'File not found but entry exists?' });
      }
  
      const mimeType = mime.getType(filePath) || 'application/octet-stream';
  
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', fileDoc.length);
      res.setHeader('Content-Disposition', `attachment; filename="${partName}"`);
      res.setHeader('X-Archive-Source', fileDoc.archivePath);
  
      stream.pipe(res);
  
      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).send({ error: 'Error reading file' });
        }
      });
    } catch (err) {
      console.error('Download error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/download/{*filePath}', async (req, res) => {
    const filePath = getFilePath(req);
    const [partName, parent] = splitNameAndParent(filePath);
    // Get first matching file from MongoDB
    const fileDoc = await filesCollection.findOne({ name: partName, parent });
    
    if (!fileDoc) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    if (fileDoc.length === 0) {
      return res.status(204).send();
    }
    try {
      const stream = await createStreamFromOffset({
        name: fileDoc.name,
        filePath: fileDoc.archivePath,
        crc32: fileDoc.crc32,
        offset: fileDoc.offset,
        length: fileDoc.length,
        compressedLength: fileDoc.compressedLength,
        compressionMethod: fileDoc.compressionMethod
      });

      if (stream === null) {
        return res.status(404).json({ error: 'File not found but entry exists?' });
      }

      const mimeType = mime.getType(filePath) || 'application/octet-stream';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', fileDoc.length);
      res.setHeader('Content-Disposition', `inline; filename="${filePath.split('/').pop()}"`);

      stream.pipe(res);

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).send({ error: 'Error reading file' });
        }
      });
    } catch (err) {
      return res.status(500);
    }
  })

  app.use(express.static('./public'));
  
  app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
  })
}

main();

