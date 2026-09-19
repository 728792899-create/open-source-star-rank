import { useReducedMotion } from 'motion/react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { signed, weeklySeries } from './data.js';

export default function TrendChart({ project }) {
  const reduced = useReducedMotion();
  const values = weeklySeries(project);
  if (!values.length) return <p className="chart-empty">这个快照的趋势数据尚未补齐，不会将缺失记录当成 0。</p>;
  return <>
    <div className="large-chart" role="img" aria-label={`${project.name} 近7日每日 Star 净增（演示数据）。详细数值在下方数据表。`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <AreaChart data={values} margin={{ left: -18, right: 10, top: 12, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#e6e2d9" strokeDasharray="3 5" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: '#686e63', fontSize: 12 }} interval={2} />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: '#686e63', fontSize: 12 }} />
          <Tooltip contentStyle={{ background: '#fffefc', border: '1px solid #e7e2d9', borderRadius: 10, fontSize: 13 }} formatter={value => [signed(value), '当日净增']} />
          <Area type="monotone" dataKey="value" stroke="#c94c22" strokeWidth={2.5} fill="#f9e4d9" isAnimationActive={!reduced} animationDuration={420} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <details className="chart-data"><summary>查看每日数值</summary><table><caption>演示快照：{project.asOf}</caption><thead><tr><th>日期</th><th>净增</th></tr></thead><tbody>{values.map(item => <tr key={item.day}><th scope="row">{item.day}</th><td>{signed(item.value)}</td></tr>)}</tbody></table></details>
  </>;
}
