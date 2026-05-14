import React, { useState, useMemo, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer
} from "recharts";
import {
  Calendar, Wallet, Lock, AlertTriangle, CheckCircle,
  PiggyBank, Activity, Crosshair, TrendingUp, Briefcase, Coins,
  Zap, Shield, Receipt, Gift
} from "lucide-react";

// ============================================================
// UK TAX CONSTANTS (England, 2024-25)
// ============================================================
const PA = 12570;                 // Personal Allowance
const BASIC_LIMIT = 50270;        // End of basic rate band
const HIGHER_LIMIT = 125140;      // End of higher rate band
const PA_TAPER = 100000;          // PA taper threshold
const NI_LOWER = 12570;           // Primary threshold
const NI_UPPER = 50270;           // Upper earnings limit
const NI_PRIMARY = 0.08;          // 8% on band
const NI_UPPER_RATE = 0.02;       // 2% above

// ============================================================
// TAX ENGINE
// ============================================================
function personalAllowance(income) {
  if (income <= PA_TAPER) return PA;
  const taper = Math.min(PA, (income - PA_TAPER) / 2);
  return Math.max(0, PA - taper);
}

function incomeTax(taxableIncome) {
  if (taxableIncome <= 0) return 0;
  const pa = personalAllowance(taxableIncome);
  let tax = 0;
  const basicBand = Math.max(0, Math.min(taxableIncome, BASIC_LIMIT) - pa);
  tax += basicBand * 0.20;
  const higherBand = Math.max(0, Math.min(taxableIncome, HIGHER_LIMIT) - BASIC_LIMIT);
  tax += higherBand * 0.40;
  const additionalBand = Math.max(0, taxableIncome - HIGHER_LIMIT);
  tax += additionalBand * 0.45;
  return tax;
}

function nationalInsurance(salary) {
  if (salary <= NI_LOWER) return 0;
  let ni = (Math.min(salary, NI_UPPER) - NI_LOWER) * NI_PRIMARY;
  if (salary > NI_UPPER) ni += (salary - NI_UPPER) * NI_UPPER_RATE;
  return ni;
}

// Salary sacrifice model.
// - Pension % is applied to BASE salary (typical UK pensionable pay).
// - Bonus is fully taxable income (no pension sacrifice on bonus by default).
// - Salary growth = inflation, so all amounts here are in today's £ (real terms).
function cashFlow(baseSalary, bonusPct, personalPct, employerPct) {
  const bonus = baseSalary * (bonusPct / 100);
  const personalPension = baseSalary * (personalPct / 100);
  const employerPension = baseSalary * (employerPct / 100);
  const grossTotal = baseSalary + bonus;
  const taxableIncome = Math.max(0, grossTotal - personalPension);
  const tax = incomeTax(taxableIncome);
  const ni = nationalInsurance(taxableIncome);
  const net = taxableIncome - tax - ni;
  return {
    baseSalary,
    bonus,
    grossTotal,
    personalPension,
    employerPension,
    totalPension: personalPension + employerPension,
    taxableIncome,
    tax,
    ni,
    net,
    effectiveTaxRate: grossTotal > 0 ? (tax + ni) / grossTotal : 0,
  };
}

// ============================================================
// ACCUMULATION & DEPLETION SIMULATION (in REAL terms)
// ASSUMPTIONS:
//   - Salary grows in line with inflation → real salary is constant.
//   - After FIRE: NO further pension contributions (early retirement).
//   - ISA & Pension have separate nominal return assumptions.
// ============================================================
function simulate(p) {
  const realReturnISA = (1 + p.nominalReturnISA / 100) / (1 + p.inflation / 100) - 1;
  const realReturnPension = (1 + p.nominalReturnPension / 100) / (1 + p.inflation / 100) - 1;
  const cf = cashFlow(p.baseSalary, p.bonusPct, p.personalPct, p.employerPct);
  const annualISA = Math.max(0, p.monthlyISA * 12 + (p.isaScaling || 0));

  let isa = p.currentISA;
  let pension = p.currentPension;
  const data = [{
    age: p.currentAge,
    isa: Math.round(isa),
    pension: Math.round(pension),
    total: Math.round(isa + pension),
    phase: 'accumulate',
  }];

  const endAge = 95;
  for (let age = p.currentAge; age < endAge; age++) {
    let phase;
    if (age < p.retireAge) {
      // ACCUMULATION: real salary constant → constant real contributions
      phase = 'accumulate';
      isa = isa * (1 + realReturnISA) + annualISA;
      pension = pension * (1 + realReturnPension) + cf.totalPension;
    } else if (age < p.pensionAge) {
      // BRIDGE: no salary, no pension contribution. ISA funds expenses.
      phase = 'bridge';
      isa = isa * (1 + realReturnISA) - p.annualExpenses;
      pension = pension * (1 + realReturnPension); // grows on its own
    } else {
      // POST-PENSION ACCESS: withdraw proportionally from both pots
      phase = 'pension';
      const liveIsa = Math.max(0, isa);
      const livePension = Math.max(0, pension);
      const total = liveIsa + livePension;
      if (total >= p.annualExpenses) {
        const isaShare = total > 0 ? liveIsa / total : 0;
        const pensionShare = total > 0 ? livePension / total : 0;
        isa = liveIsa * (1 + realReturnISA) - p.annualExpenses * isaShare;
        pension = livePension * (1 + realReturnPension) - p.annualExpenses * pensionShare;
      } else {
        isa = 0;
        pension = 0;
      }
    }
    data.push({
      age: age + 1,
      isa: Math.round(Math.max(0, isa)),
      pension: Math.round(Math.max(0, pension)),
      total: Math.round(Math.max(0, isa) + Math.max(0, pension)),
      phase,
    });
  }
  return { data, cashFlow: cf, realReturnISA, realReturnPension };
}

// PV of annuity using ISA's real return (bridge is funded by ISA only)
function requiredISAforBridge(annualExpenses, realReturn, bridgeYears) {
  if (bridgeYears <= 0) return 0;
  if (Math.abs(realReturn) < 1e-9) return annualExpenses * bridgeYears;
  return annualExpenses * (1 - Math.pow(1 + realReturn, -bridgeYears)) / realReturn;
}

// ============================================================
// REVERSE ENGINEER: minimum BASE salary that secures the bridge.
// Bonus % stays constant — bonus scales with base salary.
// Net surplus over current take-home is invested in ISA.
// ============================================================
function reverseEngineerSalary(p) {
  const baseCF = cashFlow(p.baseSalary, p.bonusPct, p.personalPct, p.employerPct);
  const baseNet = baseCF.net;
  const bridgeYears = p.pensionAge - p.retireAge;

  const trial = (base) => {
    const cf = cashFlow(base, p.bonusPct, p.personalPct, p.employerPct);
    const surplus = cf.net - baseNet;
    const sim = simulate({ ...p, baseSalary: base, isaScaling: surplus });
    const retirePoint = sim.data.find(d => d.age === p.retireAge);
    const required = requiredISAforBridge(p.annualExpenses, sim.realReturnISA, bridgeYears);
    return {
      isa: retirePoint?.isa ?? 0,
      total: retirePoint?.total ?? 0,
      required,
      gap: required - (retirePoint?.isa ?? 0),
    };
  };

  let lo = 1000, hi = 1_500_000;
  const hiResult = trial(hi);
  if (hiResult.gap > 0) {
    return { required: null, unreachable: true, currentTrial: trial(p.baseSalary) };
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const t = trial(mid);
    if (t.gap > 0) lo = mid;
    else hi = mid;
    if (hi - lo < 50) break;
  }
  const required = Math.ceil(hi / 100) * 100;
  const baseTrial = trial(p.baseSalary);
  return {
    required,
    alreadySecure: baseTrial.gap <= 0,
    currentTrial: baseTrial,
  };
}

// ============================================================
// FORMATTERS
// ============================================================
const fmtGBP = (n) => '£' + Math.round(n).toLocaleString('en-GB');
const fmtGBPshort = (n) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '£' + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000) return sign + '£' + (abs / 1_000).toFixed(1) + 'k';
  return sign + '£' + Math.round(abs);
};

// ============================================================
// UI PRIMITIVES
// ============================================================
function Slider({ label, value, setValue, min, max, step, unit }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className="text-[11px] font-mono text-emerald-400">
          {unit === '£' ? '£' : ''}
          {Number(value).toLocaleString('en-GB')}
          {unit && unit !== '£' ? unit : ''}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
      />
    </div>
  );
}

function NumberInput({ label, value, setValue, step = 1000, prefix = '£' }) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <div className="relative">
        {prefix && (
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500 font-mono">{prefix}</span>
        )}
        <input
          type="number" value={value} step={step}
          onChange={(e) => setValue(Number(e.target.value) || 0)}
          className={`w-full bg-zinc-900 border border-zinc-800 rounded text-[12px] font-mono text-emerald-400 py-1.5 ${prefix ? 'pl-5' : 'pl-2'} pr-2 focus:border-emerald-500 focus:outline-none`}
        />
      </div>
    </div>
  );
}

function KPI({ label, value, sub, icon: Icon, accent }) {
  const accentBorder = accent === 'emerald' ? 'border-l-2 border-l-emerald-500'
    : accent === 'amber' ? 'border-l-2 border-l-amber-500'
    : accent === 'cyan' ? 'border-l-2 border-l-cyan-500'
    : accent === 'purple' ? 'border-l-2 border-l-purple-500' : '';
  const accentText = accent === 'emerald' ? 'text-emerald-400'
    : accent === 'amber' ? 'text-amber-400'
    : accent === 'cyan' ? 'text-cyan-400'
    : accent === 'purple' ? 'text-purple-400' : 'text-zinc-100';
  return (
    <div className={`bg-zinc-900/60 border border-zinc-800 rounded-lg p-3 ${accentBorder}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-bold text-zinc-500 tracking-wider">{label}</span>
        {Icon && <Icon size={12} className="text-zinc-600" />}
      </div>
      <div className={`text-base font-bold font-mono ${accentText}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function Row({ label, value, accent, bold }) {
  const colors = {
    emerald: 'text-emerald-400',
    red: 'text-red-400',
    amber: 'text-amber-400',
    cyan: 'text-cyan-400',
  };
  return (
    <div className="flex justify-between items-center">
      <span className="text-zinc-500">{label}</span>
      <span className={`${accent ? colors[accent] : 'text-zinc-200'} ${bold ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function UKAdvancedFIREPlanner() {
  // ------ Basic Info ------
  const [currentAge, setCurrentAge] = useState(29);
  const [retireAge, setRetireAge] = useState(40);
  const pensionAge = 57;

  // ------ Income ------
  const [baseSalary, setBaseSalary] = useState(71500);
  const [bonusPct, setBonusPct] = useState(15);

  // ------ Savings & Investment ------
  const [personalPct, setPersonalPct] = useState(8);
  const [employerPct, setEmployerPct] = useState(5);
  const [monthlyISA, setMonthlyISA] = useState(1500);
  const [currentISA, setCurrentISA] = useState(50000);
  const [currentPension, setCurrentPension] = useState(40000);

  // ------ Macro Assumptions (split returns) ------
  const [nominalReturnISA, setNominalReturnISA] = useState(7);
  const [nominalReturnPension, setNominalReturnPension] = useState(6);
  const [inflation, setInflation] = useState(2.5);
  const [annualExpenses, setAnnualExpenses] = useState(40000);

  useEffect(() => {
    if (retireAge <= currentAge) setRetireAge(Math.min(currentAge + 1, pensionAge));
  }, [currentAge]); // eslint-disable-line

  const params = {
    currentAge, retireAge, pensionAge,
    baseSalary, bonusPct,
    personalPct, employerPct,
    monthlyISA, currentISA, currentPension,
    nominalReturnISA, nominalReturnPension, inflation, annualExpenses,
  };

  const sim = useMemo(() => simulate(params), [
    currentAge, retireAge, baseSalary, bonusPct,
    personalPct, employerPct, monthlyISA, currentISA, currentPension,
    nominalReturnISA, nominalReturnPension, inflation, annualExpenses,
  ]);

  const retirePoint = sim.data.find(d => d.age === retireAge) || { isa: 0, pension: 0, total: 0 };
  const pensionAgePoint = sim.data.find(d => d.age === pensionAge) || { isa: 0, pension: 0, total: 0 };
  const bridgeYears = pensionAge - retireAge;
  const requiredISA = requiredISAforBridge(annualExpenses, sim.realReturnISA, bridgeYears);
  const isaGap = requiredISA - retirePoint.isa;
  const bridgeSecure = isaGap <= 0;

  const reverse = useMemo(() => reverseEngineerSalary(params), [
    currentAge, retireAge, baseSalary, bonusPct,
    personalPct, employerPct, monthlyISA, currentISA, currentPension,
    nominalReturnISA, nominalReturnPension, inflation, annualExpenses,
  ]);

  const yearsToFire = Math.max(0, retireAge - currentAge);
  const realReturnISApct = (sim.realReturnISA * 100).toFixed(2);
  const realReturnPensionPct = (sim.realReturnPension * 100).toFixed(2);
  const savingsRate = sim.cashFlow.net > 0 ? ((monthlyISA * 12) / sim.cashFlow.net) * 100 : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 font-sans">
      {/* HEADER */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500/20 p-2 rounded">
            <Zap className="text-emerald-400" size={20} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">UK Advanced FIRE Planner</h1>
            <p className="text-[11px] text-zinc-500 font-mono">
              Real-return engine · UK tax (PA / 20–40–45 / NI) · split-return ISA-Pension bridge analysis
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <div className="text-zinc-500">REAL_ISA <span className="text-cyan-400">{realReturnISApct}%</span></div>
          <div className="text-zinc-500">REAL_PEN <span className="text-purple-400">{realReturnPensionPct}%</span></div>
          <div className="text-zinc-500">YRS_TO_FIRE <span className="text-emerald-400">{yearsToFire}</span></div>
          <div className="text-zinc-500">SAV_RATE <span className="text-emerald-400">{savingsRate.toFixed(1)}%</span></div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* =============== LEFT: INPUTS =============== */}
        <div className="col-span-3 space-y-3">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 space-y-2.5">
            <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
              <Calendar size={12} className="text-emerald-400" /> BASIC INFO
            </h3>
            <Slider label="Current Age" value={currentAge} setValue={setCurrentAge} min={18} max={55} step={1} />
            <Slider label="Target Retire Age" value={retireAge} setValue={setRetireAge}
              min={Math.max(currentAge + 1, 25)} max={pensionAge} step={1} />
            <div className="text-[11px] text-zinc-500 flex justify-between pt-1 border-t border-zinc-800">
              <span>Pension Access Age</span>
              <span className="font-mono text-zinc-400">57 · locked</span>
            </div>
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 space-y-2.5">
            <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
              <Briefcase size={12} className="text-emerald-400" /> INCOME
            </h3>
            <Slider label="Base Salary" value={baseSalary} setValue={setBaseSalary}
              min={20000} max={300000} step={500} unit="£" />
            <Slider label="Bonus (% of base)" value={bonusPct} setValue={setBonusPct}
              min={0} max={100} step={1} unit="%" />
            <div className="pt-1 border-t border-zinc-800 text-[11px] flex justify-between">
              <span className="text-zinc-500 flex items-center gap-1"><Gift size={10} /> Bonus £</span>
              <span className="font-mono text-amber-400">{fmtGBP(sim.cashFlow.bonus)}</span>
            </div>
            <div className="text-[11px] flex justify-between">
              <span className="text-zinc-500">Total Gross</span>
              <span className="font-mono text-emerald-400">{fmtGBP(sim.cashFlow.grossTotal)}</span>
            </div>
            <div className="text-[10px] text-zinc-600 leading-snug pt-1 border-t border-zinc-800">
              Real salary held constant (nominal grows = inflation).
            </div>
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 space-y-2.5">
            <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
              <PiggyBank size={12} className="text-emerald-400" /> SAVINGS & INVESTMENT
            </h3>
            <Slider label="Personal Pension % (on base)" value={personalPct} setValue={setPersonalPct}
              min={0} max={40} step={0.5} unit="%" />
            <Slider label="Employer Match %" value={employerPct} setValue={setEmployerPct}
              min={0} max={20} step={0.5} unit="%" />
            <Slider label="Monthly ISA Contribution" value={monthlyISA} setValue={setMonthlyISA}
              min={0} max={3333} step={50} unit="£" />
            <NumberInput label="Current ISA Balance" value={currentISA} setValue={setCurrentISA} />
            <NumberInput label="Current Pension Balance" value={currentPension} setValue={setCurrentPension} />
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 space-y-2.5">
            <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
              <Activity size={12} className="text-emerald-400" /> MACRO ASSUMPTIONS
            </h3>
            <Slider label="ISA Nominal Return" value={nominalReturnISA} setValue={setNominalReturnISA}
              min={0} max={15} step={0.1} unit="%" />
            <Slider label="Pension Nominal Return" value={nominalReturnPension} setValue={setNominalReturnPension}
              min={0} max={15} step={0.1} unit="%" />
            <Slider label="Inflation (= salary growth)" value={inflation} setValue={setInflation}
              min={0} max={10} step={0.1} unit="%" />
            <Slider label="Target Annual Expenses" value={annualExpenses} setValue={setAnnualExpenses}
              min={10000} max={150000} step={500} unit="£" />
          </div>
        </div>

        {/* =============== RIGHT: DASHBOARD =============== */}
        <div className="col-span-9 space-y-4">
          {/* KPI strip */}
          <div className="grid grid-cols-6 gap-3">
            <KPI label="TOTAL GROSS"
              value={fmtGBPshort(sim.cashFlow.grossTotal)}
              sub={`Base ${fmtGBPshort(sim.cashFlow.baseSalary)} + Bonus ${fmtGBPshort(sim.cashFlow.bonus)}`}
              icon={Briefcase} />
            <KPI label="INCOME TAX"
              value={fmtGBPshort(sim.cashFlow.tax)}
              sub={`On £${Math.round(sim.cashFlow.taxableIncome).toLocaleString('en-GB')} taxable`}
              icon={Receipt} />
            <KPI label="NATIONAL INS."
              value={fmtGBPshort(sim.cashFlow.ni)}
              sub={`8% / 2% bands · eff ${(sim.cashFlow.effectiveTaxRate * 100).toFixed(1)}%`}
              icon={Receipt} />
            <KPI label="NET TAKE-HOME"
              value={fmtGBPshort(sim.cashFlow.net)}
              sub={`After pension salary sacrifice`}
              icon={Wallet} accent="emerald" />
            <KPI label="PENSION INFLOW / YR"
              value={fmtGBPshort(sim.cashFlow.totalPension)}
              sub={`You ${fmtGBPshort(sim.cashFlow.personalPension)} + Co ${fmtGBPshort(sim.cashFlow.employerPension)}`}
              icon={Lock} accent="purple" />
            <KPI label="TOTAL @ RETIRE"
              value={fmtGBPshort(retirePoint.total)}
              sub={`ISA ${fmtGBPshort(retirePoint.isa)} · Pen ${fmtGBPshort(retirePoint.pension)}`}
              icon={TrendingUp} accent="emerald" />
          </div>

          {/* TIMELINE CHART */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                  <TrendingUp size={12} className="text-emerald-400" /> FIRE TIMELINE · REAL TERMS (today's £)
                </h3>
                <p className="text-[10px] text-zinc-500 mt-0.5">
                  ISA real <span className="font-mono text-cyan-400">{realReturnISApct}%</span>
                  {' · '}
                  Pension real <span className="font-mono text-purple-400">{realReturnPensionPct}%</span>
                  {' · '}
                  No pension contribution after retire age <span className="font-mono text-amber-400">{retireAge}</span>
                </p>
              </div>
              <div className="flex items-center gap-3 text-[11px] font-mono text-zinc-400">
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-cyan-400 rounded-full" /> ISA</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-purple-400 rounded-full" /> Pension</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-emerald-400 rounded-full" /> Total</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={sim.data} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="age" stroke="#71717a" tick={{ fontSize: 11 }}
                  label={{ value: 'Age', position: 'insideBottom', offset: -2, fill: '#71717a', fontSize: 10 }} />
                <YAxis stroke="#71717a" tick={{ fontSize: 11 }} tickFormatter={fmtGBPshort} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0a0a0a', border: '1px solid #3f3f46',
                    borderRadius: '4px', fontSize: '12px',
                  }}
                  itemStyle={{ fontFamily: 'monospace' }}
                  formatter={(v, name) => [fmtGBP(v), name]}
                  labelFormatter={(l) => `Age ${l}`}
                />
                <ReferenceLine x={retireAge} stroke="#f59e0b" strokeDasharray="4 4"
                  label={{ value: `RETIRE @ ${retireAge}`, position: 'top', fill: '#f59e0b', fontSize: 10 }} />
                <ReferenceLine x={pensionAge} stroke="#a855f7" strokeDasharray="4 4"
                  label={{ value: 'PENSION @ 57', position: 'top', fill: '#a855f7', fontSize: 10 }} />
                <Line type="monotone" dataKey="isa" stroke="#22d3ee" strokeWidth={2} dot={false} name="ISA (liquid)" />
                <Line type="monotone" dataKey="pension" stroke="#c084fc" strokeWidth={2} dot={false} name="Pension (locked)" />
                <Line type="monotone" dataKey="total" stroke="#34d399" strokeWidth={2.5} dot={false} name="Total Net Worth" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* BRIDGE + REVERSE */}
          <div className="grid grid-cols-2 gap-4">
            {/* BRIDGE STATUS */}
            <div className={`border rounded-lg p-4 ${bridgeSecure
              ? 'bg-emerald-950/20 border-emerald-800/50'
              : 'bg-red-950/20 border-red-800/50'}`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                  <Shield size={12} className={bridgeSecure ? 'text-emerald-400' : 'text-red-400'} />
                  THE BRIDGE STATUS · Retire → 57
                </h3>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${bridgeSecure
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-red-500/20 text-red-400'}`}>
                  {bridgeSecure ? 'SECURE' : 'GAP DETECTED'}
                </span>
              </div>

              <div className={`flex items-center gap-2 text-2xl font-bold mb-1 ${bridgeSecure ? 'text-emerald-400' : 'text-red-400'}`}>
                {bridgeSecure ? <CheckCircle size={22} /> : <AlertTriangle size={22} />}
                {bridgeSecure ? 'Bridge Secure' : 'ISA Funding Gap'}
              </div>
              <div className="text-[11px] text-zinc-400 mb-3">
                {bridgeSecure
                  ? `ISA pool covers ${bridgeYears} years of expenses until pension unlock at 57.`
                  : `ISA cannot bridge ${bridgeYears} years between retire and pension access.`
                }
              </div>

              <div className="space-y-1.5 text-[11px] font-mono">
                <Row label="Bridge Years (retire → 57)" value={`${bridgeYears} yrs`} />
                <Row label="Annual Expenses (real)" value={fmtGBP(annualExpenses)} />
                <Row label="ISA Required @ Retire" value={fmtGBP(requiredISA)} />
                <Row label="ISA Projected @ Retire"
                  value={fmtGBP(retirePoint.isa)}
                  accent={bridgeSecure ? 'emerald' : 'red'} />
                <div className="border-t border-zinc-800 my-1.5" />
                <Row label={bridgeSecure ? 'ISA Surplus' : 'ISA FUNDING GAP'}
                  value={fmtGBP(Math.abs(isaGap))}
                  accent={bridgeSecure ? 'emerald' : 'red'} bold />
                <Row label="ISA @ Age 57 (handoff)"
                  value={fmtGBP(Math.max(0, pensionAgePoint.isa))}
                  accent={pensionAgePoint.isa > 0 ? 'cyan' : 'red'} />
                <Row label="Pension @ Age 57 (no contrib post-retire)"
                  value={fmtGBP(pensionAgePoint.pension)} accent="purple" />
              </div>
            </div>

            {/* REVERSE ENGINEER */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                  <Crosshair size={12} className="text-amber-400" />
                  REVERSE ENGINEER · TARGET BASE SALARY
                </h3>
                <span className="text-[10px] font-mono text-zinc-500">solve(base | gap=0)</span>
              </div>

              <div className="text-[11px] text-zinc-400 mb-3">
                Min base salary today to fund retirement at age{' '}
                <span className="text-amber-400 font-mono">{retireAge}</span> with{' '}
                <span className="text-amber-400 font-mono">{fmtGBP(annualExpenses)}</span>/yr expenses,
                holding pension % and bonus % constant.
              </div>

              {reverse.unreachable ? (
                <div>
                  <div className="text-2xl font-bold text-red-400 mb-1 flex items-center gap-2">
                    <AlertTriangle size={20} /> UNREACHABLE
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    Bridge gap cannot close even at £1.5M base salary.
                    Lower expenses, retire later, or boost ISA contribution.
                  </div>
                </div>
              ) : (
                <>
                  <div className={`text-3xl font-bold font-mono ${reverse.alreadySecure ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {fmtGBP(reverse.required)}
                  </div>
                  <div className={`text-[11px] mt-1 ${reverse.alreadySecure ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {reverse.alreadySecure
                      ? `You are ${fmtGBP(baseSalary - reverse.required)} above the minimum base salary.`
                      : `Need +${fmtGBP(reverse.required - baseSalary)} above current base.`
                    }
                  </div>

                  <div className="mt-3 space-y-1.5 text-[11px] font-mono">
                    <Row label="Current Base Salary" value={fmtGBP(baseSalary)} />
                    <Row label="Required Target Base"
                      value={fmtGBP(reverse.required)} accent="amber" bold />
                    <Row label="Implied Total Gross (incl. bonus)"
                      value={fmtGBP(reverse.required * (1 + bonusPct / 100))}
                      accent="amber" />
                    <Row label="Delta vs Current Base"
                      value={(reverse.required >= baseSalary ? '+' : '−') + fmtGBP(Math.abs(reverse.required - baseSalary))}
                      accent={reverse.required >= baseSalary ? 'red' : 'emerald'} />
                    <div className="border-t border-zinc-800 my-1.5" />
                    <Row label="Bridge Gap @ Current"
                      value={fmtGBP(Math.max(0, reverse.currentTrial.gap))}
                      accent={reverse.currentTrial.gap > 0 ? 'red' : 'emerald'} />
                  </div>

                  <div className="mt-3 pt-3 border-t border-zinc-800 text-[10px] text-zinc-500 leading-relaxed">
                    <span className="text-zinc-400">Model:</span> any net surplus over current take-home is invested into
                    the ISA. Pension % & bonus % stay fixed, so both contributions scale with base salary.
                  </div>
                </>
              )}
            </div>
          </div>

          {/* PHASE LEGEND FOOTER */}
          <div className="grid grid-cols-3 gap-3 text-[10px] font-mono">
            <div className="bg-zinc-900/40 border border-zinc-800 rounded p-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
              <span className="text-zinc-500">ACCUMULATE · salary, contribs both pots</span>
              <span className="text-zinc-300 ml-auto">{currentAge} → {retireAge}</span>
            </div>
            <div className="bg-zinc-900/40 border border-zinc-800 rounded p-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-amber-400 rounded-full" />
              <span className="text-zinc-500">BRIDGE · ISA draws, Pension grows</span>
              <span className="text-zinc-300 ml-auto">{retireAge} → 57</span>
            </div>
            <div className="bg-zinc-900/40 border border-zinc-800 rounded p-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-purple-400 rounded-full" />
              <span className="text-zinc-500">PENSION UNLOCKED · prop. drawdown</span>
              <span className="text-zinc-300 ml-auto">57+</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
