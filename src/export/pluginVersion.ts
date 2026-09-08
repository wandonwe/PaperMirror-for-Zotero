/**
 * 运行中的插件版本 (2.8.8, 导出方案 P3)。
 *
 * 导出文件的名字与首行 manifest 都要写版本,而且**必须是正在跑的这一份**:
 * 版本写错的诊断比没有诊断更坏 —— 它会把排障引到另一份代码上。所以不读常量、
 * 不硬编码,而是在 `startup(params)` 时把 `params.version`(由 `bootstrap.js` 从
 * manifest 传入)记在这里,导出时来取。
 *
 * 拿不到就返回空串 —— 写出内核见到空版本会**拒绝写文件**,不会写出一份没有
 * 版本或版本存疑的导出。
 */

let running = '';

export function setPluginVersion(version: string): void {
	running = (version ?? '').trim();
}

export function pluginVersion(): string {
	return running;
}
