// Tab: Trends — zero-filled timeseries charts (traffic, tokens, cost, latency).
import { api } from '../api';
import { must } from '../utils';
import { lineChart, barChart } from '../charts';
const PURPLE = '#6f42c1';
const TEAL = '#0dcaf0';
const GREEN = '#198754';
const AMBER = '#fd7e14';
const RED = '#dc3545';
export async function renderTrends(f) {
    const q = `?days=${f.days}` + (f.username ? `&username=${encodeURIComponent(f.username)}` : '');
    const ts = await api('/api/analytics/timeseries' + q);
    const labels = ts.points.map(p => p.day.slice(5));
    const ds = (label, data, color, fill = false) => ({
        label, data, borderColor: color, backgroundColor: color + (fill ? '33' : ''), fill, tension: 0.3, pointRadius: 2,
    });
    lineChart('chTraffic', labels, [
        ds('AI calls', ts.points.map(p => p.calls), PURPLE, true),
        ds('Sessions', ts.points.map(p => p.sessions), TEAL),
    ]);
    lineChart('chTokens', labels, [
        ds('Input', ts.points.map(p => p.input_tokens), GREEN),
        ds('Output', ts.points.map(p => p.output_tokens), AMBER),
    ]);
    barChart('chCost', labels, [ds('Cost USD', ts.points.map(p => p.cost_usd), PURPLE)]);
    lineChart('chLatency', labels, [ds('Avg latency ms', ts.points.map(p => p.avg_latency_ms), RED)]);
    must('trendsMeta').textContent = `${ts.points.length} day(s) · zero-filled · ${ts.timestamp}`;
}
//# sourceMappingURL=trends.js.map