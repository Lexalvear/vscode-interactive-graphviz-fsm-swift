'use strict';
/**
 * @author github.com/tintinweb
 * @license MIT
 *
* */


/** imports */
const vscode = require("vscode");
const path =  require("path");
const fs = require("fs");

/** global vars */


/** classdecs */

class InteractiveWebviewGenerator {

    constructor(context, content_folder) {
        this.context = context;
        this.webviewPanels = new Map();
        this.timeout = null;
        this.content_folder = content_folder;
    }

    setNeedsRebuild(uri, needsRebuild) {
        let panel = this.webviewPanels.get(uri);

        if (panel) {
            panel.setNeedsRebuild(needsRebuild);
            this.rebuild();
        }
    }

    getPanel(uri){
        return this.webviewPanels.get(uri);
    }

    dispose() {
    }

    rebuild() {
        this.webviewPanels.forEach(panel => {
            if(panel.getNeedsRebuild() && panel.getPanel().visible) {
                this.updateContent(panel, vscode.workspace.textDocuments.find(doc => doc.uri == panel.uri));
            }
        });
    }

    async revealOrCreatePreview(displayColumn, doc) {
        let that = this;
        return new Promise(function(resolve, reject) {
            let previewPanel = that.webviewPanels.get(doc.uri);

            if (previewPanel) {
                previewPanel.reveal(displayColumn);
            }
            else {
                previewPanel = that.createPreviewPanel(doc, displayColumn);
                that.webviewPanels.set(doc.uri, previewPanel);
                // when the user closes the tab, remove the panel
                previewPanel.getPanel().onDidDispose(() => that.webviewPanels.delete(doc.uri), undefined, that.context.subscriptions);
                // when the pane becomes visible again, refresh it
                previewPanel.getPanel().onDidChangeViewState(_ => that.rebuild());

                previewPanel.getPanel().webview.onDidReceiveMessage(e => that.handleMessage(previewPanel, e), undefined, that.context.subscriptions);
            }

            that.updateContent(previewPanel, doc)
                .then(previewPanel => {
                    resolve(previewPanel);
                });
        });
    }

    handleMessage(previewPanel, message) {
        console.log(`Message received from the webview: ${message.command}`);

        switch(message.command){
            case 'onRenderFinished':
                previewPanel.onRenderFinished(message);
                break;
            case 'onPageLoaded':
                previewPanel.onPageLoaded(message);
                break;
            case 'onClick':
                previewPanel.onClick(message);
                break;
            case 'onDblClick':
                console.log("dblclick --> navigate to code location");
                break;
            case 'saveAs':
                let filter;

                if(message.value.type=="dot"){
                    filter = {'Graphviz Dot Files':['dot']};
                } else if(message.value.type=="svg"){
                    filter = {'Images':['svg']};
                } else {
                    return;
                }
                vscode.window.showSaveDialog({
                    saveLabel:"export",
                    filters: filter
                })
                .then((fileUri) => {
                    if(fileUri){
                        fs.writeFile(fileUri.fsPath, message.value.data, function(err) {
                            if(err) {
                                return console.log(err);
                            }
                            previewPanel.webview.postMessage({ command: 'saveSvgSuccess' });
                            console.log("File Saved");
                        });
                    }
                });
                break;
            default:
                previewPanel.handleMessage(message);
                //forward unhandled messages to previewpanel
        }
    }

    createPreviewPanel(doc, displayColumn ) {
        let previewTitle = `Preview: '${path.basename(vscode.window.activeTextEditor.document.fileName)}'`;

        let webViewPanel = vscode.window.createWebviewPanel('graphvizPreview', previewTitle, displayColumn, {
            enableFindWidget: false,
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "content"))]
        });

        webViewPanel.iconPath = vscode.Uri.file(this.context.asAbsolutePath(path.join("content","icon.png")));

        return new PreviewPanel(this, doc.uri, webViewPanel);
    }

    async updateContent(previewPanel, doc) {
        return new Promise(async (resolve, reject) => {
            if(!previewPanel.getPanel().webview.html) {
                previewPanel.getPanel().webview.html = "Please wait...";
            }
            previewPanel.setNeedsRebuild(false);
            previewPanel.getPanel().webview.html = await this.getPreviewHtml(previewPanel, doc);
            return resolve(previewPanel);
        });
    }

    async getPreviewTemplate(context, templateName){
        let previewPath = context.asAbsolutePath(path.join(this.content_folder, templateName));

        return new Promise((resolve, reject) => {
            fs.readFile(previewPath, "utf8", function (err, data) {
                if (err) reject(err);
                else resolve(data);
            });
        });
    }

    async getPreviewHtml(previewPanel, doc){
        let templateHtml = await this.getPreviewTemplate(this.context, "index.html");

        templateHtml = templateHtml.replace(/<script .*?src="(.+)">/g, (scriptTag, srcPath) => {
            let resource=vscode.Uri.file(
                path.join(this.context.extensionPath, this.content_folder, path.join(...(srcPath.split("/")))))
                    .with({scheme: "vscode-resource"});
            return `<script src="${resource}">`;
        }).replace(/<link rel="stylesheet" href="(.+)"\/>/g, (scriptTag, srcPath) => {
            let resource=vscode.Uri.file(
                path.join(this.context.extensionPath, this.content_folder, path.join(...(srcPath.split("/")))))
                    .with({scheme: "vscode-resource"});
            return `<link rel="stylesheet" href="${resource}"/>`;
        });
        return templateHtml;
    }
}

class PreviewPanel {

    constructor( parent, uri,  panel) {
        this.parent = parent;
        this.needsRebuild = false;
        this.uri = uri;
        this.panel = panel;

        this.lockRender = false;
        this.lastRender = Date.now();
        this.waitingForRendering = null;
        this.enableRenderLock = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("renderLock");
        this.minRenderInterval = vscode.workspace.getConfiguration('graphviz-interactive-preview').get("minRenderInterval");
    }

    reveal(displayColumn) {
        this.panel.reveal(displayColumn);
    }

    setNeedsRebuild(needsRebuild) {
        this.needsRebuild = needsRebuild;
    }

    getNeedsRebuild() {
        return this.needsRebuild;
    }

    getPanel() {
        return this.panel;
    }

    renderDot(dotSrc) {
        let now = Date.now();
        // filter out any sub-5ms changes, those are probably just events double-bouncing
        if(now - this.lastRender < 5) {
            return;
        }
        // schedule the last time- or lock- blocked request for the time after the current rednering finishes
        if(now - this.lastRender < this.minRenderInterval) {
            this.waitingForRendering = dotSrc;
            return;
        }
        if(this.enableRenderLock && this.lockRender) {
            this.waitingForRendering = dotSrc;
            return;
        }
        this.lockRender = true;
        this.lastRender = now;
        this.panel.webview.postMessage({ command: 'renderDot', value: dotSrc });
    }

    handleMessage(message){
        console.warn('Unexpected command: ' + message.command);
    }

    onRenderFinished(message){
        this.lockRender = false;
        if (this.waitingForRendering) {
            let dotSrc = this.waitingForRendering;
            this.waitingForRendering = null;
            this.renderDot(dotSrc);
        }
    }

    onPageLoaded(message){
        this.panel.webview.postMessage({
            command: 'setConfig',
            value : {
                transitionDelay : vscode.workspace.getConfiguration('graphviz-interactive-preview').get("view.transitionDelay"),
                transitionaDuration : vscode.workspace.getConfiguration('graphviz-interactive-preview').get("view.transitionDuration")
            }
        });
        if (this.waitingForRendering) {
            let dotSrc = this.waitingForRendering;
            this.waitingForRendering = null;
            this.renderDot(dotSrc);
        }
    }

    onClick(message){
        console.debug(message);
    }
}


module.exports = {
    InteractiveWebviewGenerator:InteractiveWebviewGenerator
};
