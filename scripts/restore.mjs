import { dataDirectory, loadEnvironment } from '../lib/local-storage.mjs';
import { restoreData } from './data-backup.mjs';
loadEnvironment();
const args = process.argv.slice(2).filter(arg=>arg !== '--'), paths = args.filter(arg=>arg !== '--replace');
if (paths.length !== 1 || args.length > 2) throw new Error('用法：pnpm restore -- <备份目录> [--replace]');
const result = restoreData(paths[0], dataDirectory(), args.includes('--replace'));
console.log('恢复完成：' + result.directory + (result.previous ? '\n旧数据保留：' + result.previous : ''));
