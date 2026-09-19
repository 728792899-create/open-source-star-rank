import { Component, useEffect, useId, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { IconAlertCircle, IconCheck, IconLink, IconRefresh, IconX } from '@tabler/icons-react';
import { signed, weeklySeries } from './data.js';

export const easing = [0.22, 1, 0.36, 1];
export function ProjectLogo({ project, small = false }) {
  return <img className={`project-logo ${small ? 'small' : ''}`} src={`/assets/${project.id}.png`} alt="" width={small ? 32 : 56} height={small ? 32 : 56} decoding="async" />;
}
export function Sparkline({ project }) {
  const canvas = useRef(null);
  const values = project.dailyTrend || [];
  useEffect(() => {
    if (!values.length) return;
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = 108, height = 45;
    element.width = width * ratio;
    element.height = height * ratio;
    ctx.scale(ratio, ratio);
    const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
    const points = values.map((value, i) => [2 + i * 104 / Math.max(values.length - 1, 1), 37 - (value - min) / range * 28]);
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = values.at(-1) < 0 ? '#a34936' : '#357350';
    ctx.lineWidth = 1.7;
    ctx.stroke();
    ctx.lineTo(106, 43); ctx.lineTo(2, 43); ctx.closePath();
    ctx.fillStyle = values.at(-1) < 0 ? '#f7eae5' : '#edf3e9';
    ctx.fill();
  }, [values]);
  if (!values.length) return <span className="chart-unavailable">趋势待补齐</span>;
  const description = weeklySeries(project).map(p => `${p.day} ${signed(p.value)}`).join('，');
  return <canvas ref={canvas} className="sparkline" width="108" height="45" role="img" aria-label={`${project.name} 7日每日净增：${description}（演示数据）`} />;
}
export function Feedback({ message, onDismiss, inDialog = false }) {
  return <div className={inDialog ? 'dialog-feedback' : 'toast-region'} role="status" aria-live="polite" aria-atomic="true">
    {message && <div className={`toast ${message.kind === 'error' ? 'error-toast' : ''}`}>
      {message.kind === 'error' ? <IconAlertCircle size={21} /> : <IconCheck size={21} className="toast-check" />}
      <span>{message.text}</span><button className="icon-button" aria-label="关闭提示" onClick={onDismiss}><IconX size={17} /></button>
    </div>}
  </div>;
}
export function Modal({ children, title, screenKey, onDismiss, drawer = false, wide = false, message, clearMessage, onShare, focusTarget, shareFallback }) {
  const ref = useRef(null);
  const titleRef = useRef(null);
  const titleId = useId();
  const reduced = useReducedMotion();
  useEffect(() => {
    const node = ref.current;
    const trigger = document.activeElement;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    node.showModal();
    return () => {
      node.close(); document.body.style.overflow = priorOverflow;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
      else document.querySelector('.nav-link.active')?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    ref.current.scrollTop = 0;
    const target = focusTarget ? ref.current.querySelector(focusTarget) : null;
    (target || titleRef.current)?.focus({ preventScroll: !target });
  }, [screenKey, focusTarget]);
  return <motion.dialog ref={ref} className={`modal ${drawer ? 'drawer' : ''} ${wide ? 'wide' : ''}`} aria-labelledby={titleId}
    initial={{ opacity: 0, x: drawer && !reduced ? 24 : 0, y: !drawer && !reduced ? 12 : 0 }} animate={{ opacity: 1, x: 0, y: 0 }}
    transition={{ duration: reduced ? 0 : 0.2, ease: easing }}
    onCancel={event => { event.preventDefault(); onDismiss(); }} onClick={event => { if (event.target === event.currentTarget) onDismiss(); }}>
    <div className="modal-surface">
      <div className="modal-heading"><div><span className="eyebrow">STARRANK · 开源星榜</span><h2 ref={titleRef} tabIndex={-1} id={titleId}>{title}</h2></div>
        <div className="panel-header-actions">{onShare && <button className="icon-button" aria-label="复制此页面链接" title="复制链接" onClick={onShare}><IconLink size={20} /></button>}<button className="icon-button close-button" onClick={onDismiss} aria-label="关闭面板"><IconX size={21} /></button></div>
      </div>
      <Feedback message={message} onDismiss={clearMessage} inDialog />
      <div className="modal-body">{shareFallback && <ShareFallback url={shareFallback} />}{children}</div>
    </div>
  </motion.dialog>;
}
export function ShareFallback({ url }) {
  return <div className="share-fallback"><label>复制当前链接<input aria-label="当前分享链接" readOnly value={url} onFocus={event => event.target.select()} /></label><p>浏览器未允许自动复制，可选中链接手动复制。本机预览链接仅在这台电脑有效。</p></div>;
}
export function LoadingState({ chart = false }) {
  return <div className={chart ? 'chart-loading' : 'loading-state'} role="status" aria-live="polite" aria-busy="true"><IconRefresh size={22} /><span>{chart ? '正在加载趋势图…' : '正在读取演示快照…'}</span>{!chart && <div className="loading-lines" aria-hidden="true"><i /><i /><i /></div>}</div>;
}
export class PanelBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="empty-state" role="alert"><IconAlertCircle size={30} /><h3>这个面板暂时无法加载</h3><p>重新载入后，链接中的筛选和本机收藏仍会保留。</p><button className="button" onClick={() => window.location.reload()}>重新载入</button></div> : this.props.children;
  }
}
