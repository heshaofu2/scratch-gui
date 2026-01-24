/**
 * 嵌入式编辑器入口
 * 支持通过 postMessage 与父页面通信
 */

// Polyfills
import 'es6-object-assign/auto';
import 'core-js/fn/array/includes';
import 'core-js/fn/promise/finally';
import 'intl';

import React from 'react';
import ReactDOM from 'react-dom';
import {compose} from 'redux';
import {connect, Provider} from 'react-redux';

import AppStateHOC from '../lib/app-state-hoc.jsx';
import GUI from '../containers/gui.jsx';
import HashParserHOC from '../lib/hash-parser-hoc.jsx';
import supportedBrowser from '../lib/supported-browser';
import BrowserModalComponent from '../components/browser-modal/browser-modal.jsx';

import styles from './index.css';

// 禁用导航离开警告，由父页面控制
if (typeof window === 'object') {
    window.onbeforeunload = null;
}

// 检查是否在 iframe 中
const isEmbedded = window.parent !== window;

// 通知父页面编辑器状态
const notifyParent = (type, data) => {
    if (isEmbedded) {
        window.parent.postMessage({ source: 'scratch-gui', type, data }, '*');
    }
};

// 用于防止并发加载项目
let isLoadingProject = false;

// VM 监听组件 - 用于在 GUI 挂载后获取 VM 引用并设置通信
class VMListener extends React.Component {
    componentDidMount() {
        this.setupMessageHandler();
        this.notifyReady();
    }

    componentDidUpdate(prevProps) {
        if (this.props.vm && !prevProps.vm) {
            this.notifyReady();
        }
    }

    notifyReady() {
        if (this.props.vm) {
            notifyParent('EDITOR_READY', { ready: true });
        }
    }

    setupMessageHandler() {
        window.addEventListener('message', this.handleParentMessage.bind(this));
    }

    handleParentMessage(event) {
        if (!event.data || event.data.source !== 'scratch-parent') return;

        const { type, data } = event.data;
        const vm = this.props.vm;

        if (!vm) {
            notifyParent('ERROR', { error: 'VM not ready' });
            return;
        }

        switch (type) {
            case 'LOAD_PROJECT':
                // 防止并发加载
                if (isLoadingProject) {
                    console.warn('[Scratch] LOAD_PROJECT ignored: another load is in progress');
                    return;
                }

                // 加载项目数据 (支持 JSON 字符串或对象，或 ArrayBuffer)
                console.log('[Scratch] LOAD_PROJECT received, data type:', typeof data, 'data length:', data?.length || 'N/A');
                if (data) {
                    let projectData = data;
                    // 如果是 base64 编码的 sb3 文件
                    if (typeof data === 'string' && data.startsWith('data:')) {
                        try {
                            const base64Data = data.split(',')[1];
                            console.log('[Scratch] Decoding base64, length:', base64Data?.length);
                            const binaryString = atob(base64Data);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            projectData = bytes.buffer;
                            console.log('[Scratch] Decoded to ArrayBuffer, byteLength:', projectData.byteLength);
                        } catch (decodeErr) {
                            console.error('[Scratch] Base64 decode error:', decodeErr);
                            notifyParent('PROJECT_LOADED', { success: false, error: 'Base64 decode error: ' + decodeErr.message });
                            break;
                        }
                    }

                    isLoadingProject = true;
                    vm.loadProject(projectData)
                        .then(() => {
                            console.log('[Scratch] Project loaded successfully');
                            notifyParent('PROJECT_LOADED', { success: true });
                        })
                        .catch(err => {
                            const errorMessage = err?.message || String(err) || 'Unknown error loading project';
                            console.error('[Scratch] VM loadProject error:', err);
                            notifyParent('PROJECT_LOADED', { success: false, error: errorMessage });
                        })
                        .finally(() => {
                            isLoadingProject = false;
                        });
                } else {
                    console.warn('[Scratch] LOAD_PROJECT called with empty data');
                    notifyParent('PROJECT_LOADED', { success: false, error: 'No project data provided' });
                }
                break;

            case 'SAVE_PROJECT':
                // 保存项目为 sb3 格式
                // 先检查并修复 targets 中的重复 Stage 问题
                const targets = vm.runtime.targets;
                console.log('[Scratch] Before save, targets count:', targets.length);
                targets.forEach((t, i) => {
                    console.log(`[Scratch]   Target ${i}: ${t.sprite?.name || t.getName()}, isStage: ${t.isStage}`);
                });

                // 查找重复的 Stage 并移除
                const stageTargets = targets.filter(t => t.isStage);
                if (stageTargets.length > 1) {
                    console.warn('[Scratch] Found duplicate stages, removing extras...');
                    // 保留第一个 Stage，移除其他的
                    for (let i = 1; i < stageTargets.length; i++) {
                        const duplicateStage = stageTargets[i];
                        vm.runtime.targets = vm.runtime.targets.filter(t => t !== duplicateStage);
                        console.log('[Scratch] Removed duplicate stage:', duplicateStage.getName());
                    }
                }

                vm.saveProjectSb3()
                    .then(blob => {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            notifyParent('PROJECT_SAVED', {
                                success: true,
                                data: reader.result
                            });
                        };
                        reader.onerror = () => {
                            notifyParent('PROJECT_SAVED', { success: false, error: 'Failed to read blob' });
                        };
                        reader.readAsDataURL(blob);
                    })
                    .catch(err => {
                        notifyParent('PROJECT_SAVED', { success: false, error: err.message });
                    });
                break;

            case 'GET_PROJECT_JSON':
                // 获取项目 JSON (不含资源)
                try {
                    const projectJson = vm.toJSON();
                    notifyParent('PROJECT_JSON', { success: true, data: projectJson });
                } catch (err) {
                    notifyParent('PROJECT_JSON', { success: false, error: err.message });
                }
                break;

            case 'RUN_PROJECT':
                vm.greenFlag();
                notifyParent('PROJECT_RUNNING', { success: true });
                break;

            case 'STOP_PROJECT':
                vm.stopAll();
                notifyParent('PROJECT_STOPPED', { success: true });
                break;

            case 'GET_THUMBNAIL':
                // 获取项目缩略图
                try {
                    const canvas = vm.renderer.canvas;
                    if (canvas) {
                        const thumbnailDataUrl = canvas.toDataURL('image/png');
                        notifyParent('THUMBNAIL', { success: true, data: thumbnailDataUrl });
                    } else {
                        notifyParent('THUMBNAIL', { success: false, error: 'Canvas not available' });
                    }
                } catch (err) {
                    notifyParent('THUMBNAIL', { success: false, error: err.message });
                }
                break;

            default:
                notifyParent('UNKNOWN_MESSAGE', { type });
        }
    }

    render() {
        return this.props.children;
    }
}

// 连接 Redux 以获取 VM
const mapStateToProps = state => ({
    vm: state.scratchGui.vm
});

const ConnectedVMListener = connect(mapStateToProps)(VMListener);

// 创建包装组件
const EmbeddedGUI = (props) => (
    <ConnectedVMListener>
        <GUI {...props} />
    </ConnectedVMListener>
);

// 应用 HOC
const WrappedEmbeddedGui = compose(
    AppStateHOC,
    HashParserHOC
)(EmbeddedGUI);

const appTarget = document.createElement('div');
appTarget.className = styles.app;
document.body.appendChild(appTarget);

if (supportedBrowser()) {
    GUI.setAppElement(appTarget);

    // 解析 URL 参数
    const urlParams = new URLSearchParams(window.location.search);
    const isPlayerOnly = urlParams.get('player') === 'true';

    ReactDOM.render(
        <WrappedEmbeddedGui
            canEditTitle
            canSave={false}
            isPlayerOnly={isPlayerOnly}
            onClickLogo={() => {}}
        />,
        appTarget
    );

    // 通知父页面编辑器已加载
    notifyParent('EDITOR_LOADED', { loaded: true });

} else {
    BrowserModalComponent.setAppElement(appTarget);
    const WrappedBrowserModalComponent = AppStateHOC(BrowserModalComponent, true);
    ReactDOM.render(<WrappedBrowserModalComponent onBack={() => {}} />, appTarget);
    notifyParent('BROWSER_NOT_SUPPORTED', { supported: false });
}
