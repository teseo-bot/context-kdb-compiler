import { CompilerEngine } from '../src/core/compiler-engine';
import { DocumentDistiller } from '../src/ingestion/distiller';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const rawDir = '/Users/teseohome/Documents/teseokdb/raw';
const compiledDir = '/Users/teseohome/Documents/teseokdb/compiled';

const CATEGORY_MAP: Record<string, string> = {
    'prospect-ops': 'business_ops',
    'hyperframes': 'frontend_ui',
    'llm_wiki': 'knowledge_bases',
    'AppFlowy': 'productivity_apps',
    'apify-mcp-server': 'infrastructure',
    'PaperBanana': 'research_tools',
    'Edit-Banana': 'research_tools',
    'multica': 'ai_agents',
    'multiautoresearch': 'ai_agents',
    'trackio': 'analytics',
    'alpha-eval.pdf': 'research_papers',
    'OpenKB': 'knowledge_bases',
    'goal-driven': 'ai_agents',
    'AI-penetration-testing': 'quarantine_pending_review',
    'awesome-design-md': 'frontend_ui',
    'code-review-graph': 'infrastructure',
    'gbrain': 'ai_agents',
    'onyx': 'knowledge_bases'
};

function getCategory(filePath: string, rawDir: string): string {
    const relPath = path.relative(rawDir, filePath);
    const topLevel = relPath.split(path.sep)[0];
    return CATEGORY_MAP[topLevel] || 'uncategorized';
}

async function walkDir(dir: string): Promise<string[]> {
    let files: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
            if (['.git', 'node_modules', '.idea', '.vscode', 'dist', 'build', '__pycache__', 'venv', 'env'].includes(file)) continue;
            const subFiles = await walkDir(fullPath);
            files = files.concat(subFiles);
        } else {
            files.push(fullPath);
        }
    }
    return files;
}

async function run() {
    const engine = new CompilerEngine();
    let processedCount = 0;
    
    try {
        console.log('🚀 Iniciando escaneo de la Bóveda de Ingestión (/raw)...');
        await engine.initDb();
        console.log('✅ Base de Conocimiento Vectorial Online.');
        
        if (!fs.existsSync(compiledDir)) {
            fs.mkdirSync(compiledDir, { recursive: true });
        }

        const allFiles = await walkDir(rawDir);
        
        for (const filePath of allFiles) {
            const ext = path.extname(filePath).toLowerCase();
            const relPath = path.relative(rawDir, filePath);
            const validExts = ['.md', '.txt', '.py', '.js', '.ts', '.jsx', '.tsx', '.json', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.html', '.css', '.yaml', '.yml'];
            
            if (ext !== '' && !validExts.includes(ext)) {
                continue;
            }
            
            try {
                let content = fs.readFileSync(filePath, 'utf8');
                if (!content.trim()) continue;
                
                const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
                const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9.-]/g, '_');
                const topLevel = relPath.split(path.sep)[0];
                const finalName = `${topLevel}_${safeName}_${hash}.md`;
                
                const category = getCategory(filePath, rawDir);
                const catDir = path.join(compiledDir, category);
                if (!fs.existsSync(catDir)) {
                    fs.mkdirSync(catDir, { recursive: true });
                }
                const outPath = path.join(catDir, finalName);
                
                if (fs.existsSync(outPath)) {
                    continue;
                }
                
                console.log(`🧩 Compilando y Vectorizando: ${relPath}`);
                
                await engine.compile(content, {
                    title: path.basename(filePath),
                    source: `local://${relPath}`,
                    bucket: 'local',
                    fileName: relPath
                });
                
                const distilledContent = `# TeseoKDB - RAG Distillation\nSource Path: ${relPath}\nMD5 Hash: ${hash}\n\n---\n\n${content}`;
                fs.writeFileSync(outPath, distilledContent);
                
                processedCount++;
                
            } catch (err: any) {
                if (err.message && (err.message.includes('invalid') || err.message.includes('binary'))) {
                    continue;
                }
                console.error(`❌ Error procesando ${relPath}: ${err.message}`);
            }
        }
        
        console.log(`\n✅ Escaneo Finalizado. Nuevos archivos compilados e indexados: ${processedCount}`);
    } catch (e) {
        console.error('❌ Error fatal en el Orquestador RAG:', e);
    } finally {
        await engine.close();
    }
}

run();
