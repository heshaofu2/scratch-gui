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

// 允许的父页面域名，从 URL 参数或环境变量获取
// 可通过 ?parentOrigin=https://example.com 指定
const getAllowedOrigin = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const parentOrigin = urlParams.get('parentOrigin');
    if (parentOrigin) {
        return parentOrigin;
    }
    // 如果在 iframe 中，尝试获取父页面的 origin（同源情况下）
    try {
        if (isEmbedded && window.parent.location.origin) {
            return window.parent.location.origin;
        }
    } catch (e) {
        // 跨域时无法访问，忽略
    }
    // 默认允许所有（开发环境），生产环境应明确指定
    return '*';
};

const allowedOrigin = getAllowedOrigin();

// 通知父页面编辑器状态
const notifyParent = (type, data) => {
    if (isEmbedded) {
        window.parent.postMessage({ source: 'scratch-gui', type, data }, allowedOrigin);
    }
};

// 用于防止并发加载项目
let isLoadingProject = false;

// 记录预期的 targets ID，用于检测异常增加或减少
let expectedTargetIds = new Set();

// VM 监听组件 - 用于在 GUI 挂载后获取 VM 引用并设置通信
class VMListener extends React.Component {
    constructor(props) {
        super(props);
        // 绑定事件处理函数，确保可以正确移除
        this.handleParentMessage = this.handleParentMessage.bind(this);
    }

    componentDidMount() {
        window.addEventListener('message', this.handleParentMessage);
        this.notifyReady();
    }

    componentDidUpdate(prevProps) {
        if (this.props.vm && !prevProps.vm) {
            this.notifyReady();
        }
    }

    componentWillUnmount() {
        window.removeEventListener('message', this.handleParentMessage);
    }

    notifyReady() {
        if (this.props.vm) {
            notifyParent('EDITOR_READY', { ready: true });
        }
    }

    /**
     * 清理重复的 Stage 对象
     * 这是一个 workaround，用于处理某些情况下 VM 中出现多个 Stage 的问题
     * TODO: 定位并修复产生重复 Stage 的根本原因
     */
    cleanupDuplicateStages(vm) {
        const targets = vm.runtime.targets;
        const stageTargets = targets.filter(t => t.isStage);

        if (stageTargets.length > 1) {
            console.warn(`[Scratch] Found ${stageTargets.length} stages, removing duplicates...`);
            // 保留第一个 Stage，移除其他的
            for (let i = 1; i < stageTargets.length; i++) {
                const duplicateStage = stageTargets[i];
                vm.runtime.targets = vm.runtime.targets.filter(t => t !== duplicateStage);
                console.log('[Scratch] Removed duplicate stage:', duplicateStage.getName());
            }
        }
    }

    handleParentMessage(event) {
        // 验证消息来源（如果指定了允许的 origin）
        if (allowedOrigin !== '*' && event.origin !== allowedOrigin) {
            return;
        }
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

                    // 🔧 修复：加载前清理 VM 状态，防止默认项目 targets 残留
                    // vm.clear() 会移除所有 sprites 和 stage，确保干净的加载环境
                    try {
                        vm.clear();
                        console.log('[Scratch] VM cleared before loading project');
                    } catch (clearErr) {
                        console.warn('[Scratch] VM clear failed (may be expected on first load):', clearErr.message);
                    }

                    vm.loadProject(projectData)
                        .then(() => {
                            // 🔧 修复：记录预期的 targets ID，用于后续验证
                            const initialTargets = vm.runtime.targets || [];
                            expectedTargetIds = new Set(initialTargets.map(t => t.id));
                            console.log(`[Scratch] Project JSON parsed, expected ${expectedTargetIds.size} targets, waiting for assets...`);
                            initialTargets.forEach((t, i) => {
                                const costumes = t.sprite?.costumes || t.costumes || [];
                                console.log(`[Scratch]   Target ${i}: ${t.getName()} (id: ${t.id}), costumes: ${costumes.length}`);
                            });

                            // 轮询检查所有 costume 的 skinId 是否已设置，且 targets 数量稳定
                            return new Promise((resolve) => {
                                let attempts = 0;
                                const maxAttempts = 100; // 最多等待 10 秒 (100 * 100ms)
                                let lastTargetCount = 0;
                                let stableCount = 0; // 连续稳定的次数

                                const checkAllSkinsLoaded = () => {
                                    attempts++;
                                    let targets = vm.runtime.targets || [];
                                    let allLoaded = true;
                                    let loadedCount = 0;
                                    let totalCount = 0;

                                    // 🔧 修复：检测并修复 targets 异常增加（竞态条件导致的重复）
                                    if (targets.length > expectedTargetIds.size && expectedTargetIds.size > 0) {
                                        const unexpectedTargets = targets.filter(t => !expectedTargetIds.has(t.id));
                                        if (unexpectedTargets.length > 0) {
                                            console.warn(`[Scratch] Found ${unexpectedTargets.length} unexpected targets, removing...`);
                                            unexpectedTargets.forEach(t => {
                                                console.warn(`[Scratch]   Removing: ${t.getName()} (id: ${t.id})`);
                                            });
                                            vm.runtime.targets = targets.filter(t => expectedTargetIds.has(t.id));
                                            targets = vm.runtime.targets; // 更新引用
                                        }
                                    }

                                    // 🔧 修复：检测 targets 减少（可能是资源加载失败）
                                    if (targets.length < expectedTargetIds.size) {
                                        const currentIds = new Set(targets.map(t => t.id));
                                        const missingIds = [...expectedTargetIds].filter(id => !currentIds.has(id));
                                        if (missingIds.length > 0) {
                                            console.warn(`[Scratch] Missing ${missingIds.length} targets! IDs: ${missingIds.join(', ')}`);
                                            // 注意：只记录警告，无法恢复丢失的数据
                                        }
                                    }

                                    // 🔧 修复：清理重复的 Stage
                                    const stageTargets = targets.filter(t => t.isStage);
                                    if (stageTargets.length > 1) {
                                        console.warn(`[Scratch] Found ${stageTargets.length} stages, keeping first`);
                                        vm.runtime.targets = targets.filter(t => !t.isStage || t === stageTargets[0]);
                                        targets = vm.runtime.targets;
                                    }

                                    // 检查 targets 数量是否稳定
                                    if (targets.length === lastTargetCount) {
                                        stableCount++;
                                    } else {
                                        stableCount = 0;
                                        lastTargetCount = targets.length;
                                    }

                                    for (const target of targets) {
                                        const costumes = target.sprite?.costumes || target.costumes || [];
                                        for (const costume of costumes) {
                                            totalCount++;
                                            // skinId 是数字类型，加载完成后才设置
                                            if (typeof costume.skinId === 'number') {
                                                loadedCount++;
                                            } else {
                                                allLoaded = false;
                                            }
                                        }
                                    }

                                    // 需要：所有 skinId 加载完成 且 targets 数量稳定至少 3 次
                                    if (allLoaded && totalCount > 0 && stableCount >= 3) {
                                        console.log(`[Scratch] All ${totalCount} costumes loaded, ${targets.length} targets stable`);
                                        resolve();
                                    } else if (attempts >= maxAttempts) {
                                        console.warn(`[Scratch] Asset loading timeout: ${loadedCount}/${totalCount} costumes, ${targets.length} targets`);
                                        resolve(); // 超时也继续，部分加载比完全失败好
                                    } else {
                                        // 每 100ms 检查一次
                                        setTimeout(checkAllSkinsLoaded, 100);
                                    }
                                };

                                // 给一个初始延迟让加载开始
                                setTimeout(checkAllSkinsLoaded, 50);
                            });
                        })
                        .then(() => {
                            // 额外等待一帧，确保 GUI 有机会渲染
                            return new Promise(resolve => requestAnimationFrame(resolve));
                        })
                        .then(() => {
                            // 🔧 修复：加载完成后立即清理，而非等到保存时
                            this.cleanupDuplicateStages(vm);

                            const finalTargets = vm.runtime.targets || [];
                            console.log(`[Scratch] Project loaded successfully, final targets: ${finalTargets.length}`);
                            finalTargets.forEach((t, i) => {
                                console.log(`[Scratch]   Final target ${i}: ${t.getName()} (id: ${t.id}, isStage: ${t.isStage})`);
                            });

                            // 验证最终状态
                            if (expectedTargetIds.size > 0 && finalTargets.length !== expectedTargetIds.size) {
                                console.warn(`[Scratch] Target count mismatch: expected ${expectedTargetIds.size}, got ${finalTargets.length}`);
                            }

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
                this.cleanupDuplicateStages(vm);
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
    const editorMode = urlParams.get('mode') || 'new';

    console.log(`[Scratch] Editor initializing with mode: ${editorMode}`);

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
