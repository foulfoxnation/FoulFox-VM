import { useEffect, useState } from "react";
import { Cpu, MemoryStick, HardDrive, Gauge, Zap } from "lucide-react";
import { authedFetch } from "@/lib/shell-token";

type Telemetry = {
  cpu: { cores: number; loadAvg1m: number; tempC: number | null };
  memory: { totalGb: number; usedGb: number; usedPct: number };
  disk: { totalGb: number; freeGb: number } | null;
  gpu: { name: string; tempC: number; vramUsedMb: number; vramTotalMb: number; utilPct: number } | null;
  uptimeSec: number;
};

type Benchmark = {
  available: boolean;
  message?: string;
  ranAt?: string;
  disk?: { writeMBps: number; readMBps: number };
  ai?: { model: string; tokensPerSec: number };
  gpu?: string;
};

function tempColor(t: number | null): string {
  if (t == null) return "text-muted-foreground";
  if (t >= 85) return "text-red-500";
  if (t >= 70) return "text-amber-500";
  return "text-emerald-500";
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-2">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-sm font-medium truncate">{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground truncate">{sub}</div>}
      </div>
    </div>
  );
}

export default function HardwareCard() {
  const [t, setT] = useState<Telemetry | null>(null);
  const [bench, setBench] = useState<Benchmark | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await authedFetch("/api/system/telemetry");
        if (r.ok && alive) setT(await r.json());
      } catch { /* offline */ }
    };
    poll();
    const iv = setInterval(poll, 5000);
    authedFetch("/api/system/benchmark")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => alive && b && setBench(b))
      .catch(() => { /* none */ });
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!t) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid="card-hardware">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Gauge className="h-4 w-4 text-muted-foreground" />
        Hardware
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          icon={<Cpu className="h-4 w-4" />}
          label="CPU"
          value={
            <span>
              load {t.cpu.loadAvg1m}
              {t.cpu.tempC != null && <span className={`ml-1.5 ${tempColor(t.cpu.tempC)}`}>{t.cpu.tempC}°C</span>}
            </span>
          }
          sub={`${t.cpu.cores} threads`}
        />
        <Stat
          icon={<MemoryStick className="h-4 w-4" />}
          label="Memory"
          value={<span className={t.memory.usedPct >= 90 ? "text-red-500" : t.memory.usedPct >= 75 ? "text-amber-500" : ""}>{t.memory.usedPct}%</span>}
          sub={`${t.memory.usedGb} / ${t.memory.totalGb} GB`}
        />
        <Stat
          icon={<HardDrive className="h-4 w-4" />}
          label="Disk"
          value={t.disk ? `${t.disk.freeGb} GB free` : "—"}
          sub={t.disk ? `of ${t.disk.totalGb} GB` : undefined}
        />
        <Stat
          icon={<Zap className="h-4 w-4" />}
          label="GPU"
          value={
            t.gpu ? (
              <span>
                {t.gpu.utilPct}% <span className={`ml-1.5 ${tempColor(t.gpu.tempC)}`}>{t.gpu.tempC}°C</span>
              </span>
            ) : (
              "none / CPU-only"
            )
          }
          sub={t.gpu ? `${t.gpu.name} · ${Math.round(t.gpu.vramUsedMb / 102.4) / 10}/${Math.round(t.gpu.vramTotalMb / 102.4) / 10} GB VRAM` : undefined}
        />
      </div>
      {bench?.available && (
        <div className="mt-2 text-[11px] text-muted-foreground" data-testid="text-benchmark">
          Vibe check{bench.ranAt ? ` (${bench.ranAt.slice(0, 10)})` : ""}:
          {bench.disk ? ` disk ${bench.disk.writeMBps}↓/${bench.disk.readMBps}↑ MB/s` : ""}
          {bench.ai?.tokensPerSec ? ` · AI ${bench.ai.tokensPerSec} tok/s (${bench.ai.model})` : " · AI not benchmarked yet"}
        </div>
      )}
    </div>
  );
}
