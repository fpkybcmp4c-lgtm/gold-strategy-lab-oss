import path from 'node:path';
import { dataDirectory, loadEnvironment } from '../lib/local-storage.mjs';
import { backupData } from './data-backup.mjs';
loadEnvironment();
const args = process.argv.slice(2).filter(arg=>arg !== '--');
if (args.length > 1) throw new Error('用法：pnpm backup -- <新的备份目录>');
const destination = args[0] || path.join('backups', new Date().toISOString().replaceAll(':','-'));
console.log('备份完成：' + backupData(dataDirectory(), destination));
