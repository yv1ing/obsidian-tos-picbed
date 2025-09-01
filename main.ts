import TosClient from "@volcengine/tos-sdk";
import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

interface TosPicbedPluginSettings {
    secretId: string;
    secretKey: string;
    bucket: string;
    region: string;
    prefix: string;
    usePublicUrl: boolean; // 桶公有读 => 稳定直链；私有读 => 预签名
}

const DEFAULT_SETTINGS: TosPicbedPluginSettings = {
    secretId: "",
    secretKey: "",
    bucket: "",
    region: "",
    prefix: "",
    usePublicUrl: true,
};

class TosUploader {
    private client: TosClient;
    constructor(private settings: TosPicbedPluginSettings) {
        const s = settings;
        if (!s.secretId || !s.secretKey) throw new Error("SecretId/SecretKey 为空");
        if (!s.bucket || !s.region) throw new Error("Bucket/Region 为空");
        this.client = new TosClient({
            accessKeyId: s.secretId,
            accessKeySecret: s.secretKey,
            region: s.region,
        });
    }
    private normPrefix() {
        const p = this.settings.prefix?.replace(/^\/+|\/+$/g, "");
        return p ? `${p}/` : "";
    }
    async uploadFile(file: File): Promise<{ url: string; key: string }> {
        const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
        const name = ext ? `${Date.now()}.${ext}` : `${Date.now()}`;
        const key = `${this.normPrefix()}${name}`;
        await this.client.putObject({
            bucket: this.settings.bucket,
            key,
            body: file,
            contentType: file.type || undefined,
        });
        const url = await this.getUrl(key);
        return { url, key };
    }
    async deleteByKey(key: string): Promise<void> {
        await this.client.deleteObject({ bucket: this.settings.bucket, key });
    }
    private async getUrl(key: string): Promise<string> {
        if (this.settings.usePublicUrl) {
            const safeKey = key
                .split("/")
                .map(encodeURIComponent)
                .join("/");

            return `https://${this.settings.bucket}.tos-${this.settings.region}.volces.com/${safeKey}`;
        }
        return this.client.getPreSignedUrl({ bucket: this.settings.bucket, key });
    }
    static parseKeyFromUrlOrKey(input: string): string {
        try {
            const u = new URL(input);
            return decodeURIComponent(u.pathname.replace(/^\/+/, ""));
        } catch {
            return input.replace(/^\/+/, "");
        }
    }
}

class TosPicbedSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: TosPicbedPlugin) { super(app, plugin); }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl).setName("访问令牌（Secret Id）").addText(t =>
            t.setPlaceholder("AK...").setValue(this.plugin.settings.secretId).onChange(async v => {
                this.plugin.settings.secretId = v.trim(); await this.plugin.saveSettings(); this.plugin.reinitUploaderIfReady();
            })
        );
        new Setting(containerEl).setName("访问密钥（Secret Key）").addText(t =>
            t.setPlaceholder("SK...").setValue(this.plugin.settings.secretKey).onChange(async v => {
                this.plugin.settings.secretKey = v.trim(); await this.plugin.saveSettings(); this.plugin.reinitUploaderIfReady();
            })
        );
        new Setting(containerEl).setName("存储桶（Bucket）").addText(t =>
            t.setPlaceholder("example-bucket").setValue(this.plugin.settings.bucket).onChange(async v => {
                this.plugin.settings.bucket = v.trim(); await this.plugin.saveSettings(); this.plugin.reinitUploaderIfReady();
            })
        );
        new Setting(containerEl).setName("地域（Region）").addText(t =>
            t.setPlaceholder("cn-beijing").setValue(this.plugin.settings.region).onChange(async v => {
                this.plugin.settings.region = v.trim(); await this.plugin.saveSettings(); this.plugin.reinitUploaderIfReady();
            })
        );
        new Setting(containerEl).setName("前缀（Prefix）").addText(t =>
            t.setPlaceholder("/").setValue(this.plugin.settings.prefix).onChange(async v => {
                this.plugin.settings.prefix = v.trim().replace(/^\/+|\/+$/g, ""); await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl).setName("是否使用公共链接（存储桶公有读）").addToggle(t =>
            t.setValue(this.plugin.settings.usePublicUrl).onChange(async v => {
                this.plugin.settings.usePublicUrl = v; await this.plugin.saveSettings();
            })
        );
    }
}

export default class TosPicbedPlugin extends Plugin {
    settings: TosPicbedPluginSettings;
    private uploader: TosUploader | null = null;

    async onload() {
        await this.loadSettings();
        this.reinitUploaderIfReady();

        // 粘贴：占位令牌 -> 上传 -> 替换为图片 Markdown
        this.registerEvent(
            this.app.workspace.on("editor-paste", async (evt: ClipboardEvent, editor: Editor, mdView: MarkdownView) => {
                if (!this.uploader) return;
                const items = Array.from(evt.clipboardData?.items || []);
                const imgs = items.filter(i => i.kind === "file" && i.type.startsWith("image/"));
                if (imgs.length === 0) return;

                evt.preventDefault(); // 避免 Obsidian 生成本地 ![[...]]
                const activeFile = mdView.file;
                if (!activeFile) return;

                for (const it of imgs) {
                    const f = it.getAsFile();
                    if (!f) continue;

                    // —— 使用不会被渲染为图片的占位令牌 ——
                    const token = `{{TOS_UPLOADING:${Date.now()}-${Math.random().toString(36).slice(2, 8)}}}`;
                    const pos = editor.getCursor();
                    editor.replaceRange(token, pos);

                    try {
                        const { url } = await this.uploader.uploadFile(f);
                        let doc = editor.getValue();
                        const idx = doc.indexOf(token);
                        if (idx !== -1) {
                            const from = editor.offsetToPos(idx);
                            const to = editor.offsetToPos(idx + token.length);
                            const finalMd = `![](${url})`;

                            // 如果此时光标恰好在占位符末尾，让它在替换后仍然保持在图片 Markdown 末尾
                            const cur = editor.getCursor();
                            const wasAfterToken = (cur.line === to.line && cur.ch === to.ch);

                            editor.replaceRange(finalMd, from, to);

                            if (wasAfterToken) {
                                const afterPos = editor.offsetToPos(idx + finalMd.length);
                                editor.setCursor(afterPos);
                            }
                        }

                        // 清理“Pasted image ...”残留：逐个正则命中做区间删除，避免 setValue
                        let searchDoc = editor.getValue();
                        const imgRe = /!\[\[Pasted image.*?\.(?:png|jpe?g|gif|webp|svg)\]\]/gi;
                        let m: RegExpExecArray | null;
                        while ((m = imgRe.exec(searchDoc)) !== null) {
                            const start = editor.offsetToPos(m.index);
                            const end = editor.offsetToPos(m.index + m[0].length);
                            editor.replaceRange("", start, end);
                            // 文本已变更，重新获取并重置游标位置
                            searchDoc = editor.getValue();
                            imgRe.lastIndex = 0;
                        }

                        new Notice("图片上传成功");
                    } catch (e: any) {
                        let doc = editor.getValue();
                        if (doc.includes(token)) {
                            const after = doc.replace(token, "");
                            editor.setValue(after);
                            editor.setCursor(editor.offsetToPos(after.length));
                        }
                        new Notice("图片上传失败: " + (e?.message || e));
                    }
                }
            })
        );

        // 右键菜单：删除当前行图片
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, editor) => {
                const cur = editor.getCursor();
                const line = editor.getLine(cur.line);
                const m = line.match(/!\[.*?\]\((.*?)\)/);
                if (!m || !this.uploader) return;

                menu.addItem(item => {
                    item.setTitle("删除此图片").setIcon("trash").onClick(async () => {
                        try {
                            const key = TosUploader.parseKeyFromUrlOrKey(m[1]);
                            await this.uploader!.deleteByKey(key);
                            editor.setLine(cur.line, line.replace(m[0], ""));
                            new Notice("图片删除成功");
                        } catch (e: any) {
                            new Notice("图片删除失败: " + (e?.message || e));
                        }
                    });
                });
            })
        );

        // 右键菜单：删除全部图片
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, editor) => {
                menu.addItem(item => {
                    item.setTitle("删除全部图片").setIcon("trash").onClick(async () => {
                        const all = editor.getValue();
                        const matches = [...all.matchAll(/!\[.*?\]\((.*?)\)/g)];
                        if (matches.length === 0) return new Notice("未发现图片");

                        const keys = matches.map(m => TosUploader.parseKeyFromUrlOrKey(m[1]));
                        if (this.uploader) {
                            await Promise.all(keys.map(k => this.uploader!.deleteByKey(k).catch(e =>
                                new Notice("删除失败: " + (e?.message || e))
                            )));
                        }
                        editor.setValue(all.replace(/!\[.*?\]\((.*?)\)/g, ""));
                        new Notice(`已删除 ${keys.length} 张图片`);
                    });
                });
            })
        );

        this.addSettingTab(new TosPicbedSettingTab(this.app, this));
    }

    onunload() { this.uploader = null; }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    reinitUploaderIfReady() {
        const s = this.settings;
        if (s.secretId && s.secretKey && s.bucket && s.region) {
            try { this.uploader = new TosUploader(s); } catch { this.uploader = null; }
        }
    }

    private findImageFile(imagePath: string, currentFile: TFile): TFile | null {
        let imageFile = this.app.vault.getAbstractFileByPath(imagePath);
        if (imageFile instanceof TFile && this.isImageFile(imageFile)) return imageFile;
        if (currentFile.parent) {
            const relativePath = `${currentFile.parent.path}/${imagePath}`;
            imageFile = this.app.vault.getAbstractFileByPath(relativePath);
            if (imageFile instanceof TFile && this.isImageFile(imageFile)) return imageFile;
        }
        imageFile = this.app.vault.getAbstractFileByPath(`/${imagePath}`);
        if (imageFile instanceof TFile && this.isImageFile(imageFile)) return imageFile;
        const files = this.app.vault.getFiles();
        return files.find(f => f.name === imagePath && this.isImageFile(f)) || null;
    }
    private isImageFile(file: TFile): boolean {
        return /png|jpg|jpeg|gif|svg|webp/i.test(file.extension.toLowerCase());
    }
}
