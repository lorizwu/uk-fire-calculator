import React, { useState, useMemo, useEffect } from "react";
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer
} from "recharts";
import {
  Calendar, Wallet, Lock, AlertTriangle, CheckCircle, AlertCircle,
  PiggyBank, Activity, Crosshair, TrendingUp, Briefcase,
  Zap, Shield, Receipt, Gift, Target, Info, Layers
} from "lucide-react";

// ============================================================
// UK TAX CONSTANTS (England, 2024-25)
// ============================================================
const PA = 12570;
const BASIC_LIMIT = 50270;
const HIGHER_LIMIT = 125140;
const PA_TAPER = 100000;          // PA tapering kicks in at £100k
const NI_LOWER = 12570;
const NI_UPPER = 50270;
const NI_PRIMARY = 0.08;
const NI_UPPER_RATE = 0.02;

// Pension Annual Allowance
const ANNUAL_ALLOWANCE = 60000;
const CARRY_FORWARD_YEARS = 3;    // Up to 3 prior tax years

// ============================================================
// TAX ENGINE (with PA Tapering)
// ============================================================
// PA reduces by £1 for every £2 of taxable income above £100k.
// Fully phased out by £125,140.
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

function cashFlow(baseSalary, bonusPct, personalPct, employerPct) {
  const bonus = baseSalary * (bonusPct / 100);
  const personalPension = baseSalary * (personalPct / 100);
  const employerPension = baseSalary * (employerPct / 100);
  const grossTotal = baseSalary + bonus;
  const taxableIncome = Math.max(0, grossTotal - personalPension);
  const tax = incomeTax(taxableIncome);
  const ni = nationalInsurance(taxableIncome);
  const net = taxableIncome - tax - ni;
  const pa = personalAllowance(taxableIncome);
  return {
    baseSalary, bonus, grossTotal,
    personalPension, employerPension,
    totalPension: personalPension + employerPension,
    taxableIncome, tax, ni, net,
    effectivePA: pa,
    paTapered: pa < PA,
    effectiveTaxRate: grossTotal > 0 ? (tax + ni) / grossTotal : 0,
  };
}

// ============================================================
// PENSION ANNUAL ALLOWANCE
// ============================================================
function checkAnnualAllowance(totalPension, useCarryForward) {
  const cfAvailable = useCarryForward ? ANNUAL_ALLOWANCE * CARRY_FORWARD_YEARS : 0;
  const effectiveLimit = ANNUAL_ALLOWANCE + cfAvailable;
  const overBase = Math.max(0, totalPension - ANNUAL_ALLOWANCE);
  const overEffective = Math.max(0, totalPension - effectiveLimit);
  return {
    limit: ANNUAL_ALLOWANCE,
    carryForwardAvailable: cfAvailable,
    effectiveLimit,
    contribution: totalPension,
    overBase,            // amount above £60k base
    overEffective,       // amount that would actually be taxed
    breached: totalPension > ANNUAL_ALLOWANCE,
    chargeable: overEffective > 0,
  };
}

// ============================================================
// ACCUMULATION & DEPLETION SIMULATION (REAL terms)
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
      // Accumulation
      phase = 'accumulate';
      isa = isa * (1 + realReturnISA) + annualISA;
      pension = pension * (1 + realReturnPension) + cf.totalPension;
    } else if (age < p.pensionAge) {
      // Bridge — no salary, no pension contribution
      phase = 'bridge';
      isa = isa * (1 + realReturnISA) - p.annualExpenses;
      pension = pension * (1 + realReturnPension);
    } else {
      // Pension unlocked — proportional drawdown
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
        isa = 0; pension = 0;
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

// PV of annuity — required ISA at retirement to fund bridge
function requiredISAforBridge(annualExpenses, realReturn, bridgeYears) {
  if (bridgeYears <= 0) return 0;
  if (Math.abs(realReturn) < 1e-9) return annualExpenses * bridgeYears;
  return annualExpenses * (1 - Math.pow(1 + realReturn, -bridgeYears)) / realReturn;
}

// ============================================================
// BRIDGE YEAR-BY-YEAR (allows negative for visualization)
// ============================================================
function simulateBridgeYearly(isaAtRetire, retireAge, pensionAge, annualExpenses, realReturnISA) {
  const data = [];
  let bal = isaAtRetire;
  data.push({
    age: retireAge,
    balance: Math.round(bal),
    status: bal >= 0 ? 'ok' : 'gap',
    drawn: 0,
    growth: 0,
  });
  for (let age = retireAge; age < pensionAge; age++) {
    const growth = bal * realReturnISA;
    const next = bal + growth - annualExpenses;
    data.push({
      age: age + 1,
      balance: Math.round(next),
      status: next < 0 ? 'gap' : 'ok',
      drawn: Math.round(annualExpenses),
      growth: Math.round(growth),
    });
    bal = next;
  }
  return data;
}

// ============================================================
// REVERSE ENGINEER · SURPLUS MODEL
// "What's the min salary above current that closes the gap?"
// (extra net income above current take-home flows into ISA)
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
  if (trial(hi).gap > 0) return { required: null, unreachable: true, currentTrial: trial(p.baseSalary) };
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (trial(mid).gap > 0) lo = mid; else hi = mid;
    if (hi - lo < 50) break;
  }
  const required = Math.ceil(hi / 100) * 100;
  const baseTrial = trial(p.baseSalary);
  return { required, alreadySecure: baseTrial.gap <= 0, currentTrial: baseTrial };
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
function Slider({ label, value, setValue, min, max, step, unit, disabled }) {
  return (
    <div className={`space-y-1 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className="text-[11px] font-mono text-emerald-400">
          {unit === '£' ? '£' : ''}
          {Number(value).toLocaleString('en-GB')}
          {unit && unit !== '£' ? unit : ''}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        disabled={disabled}
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

function Toggle({ label, checked, onChange, hint, color = 'emerald' }) {
  const onColor = color === 'amber' ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <button
      onClick={() => onChange(!checked)}
      className="w-full flex items-start justify-between gap-2 text-left"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-zinc-200 font-bold">{label}</div>
        {hint && <div className="text-[10px] text-zinc-500 leading-snug">{hint}</div>}
      </div>
      <span className={`relative w-9 h-5 rounded-full transition shrink-0 ${checked ? onColor : 'bg-zinc-700'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

function KPI({ label, value, sub, icon: Icon, accent }) {
  const accentBorder = accent === 'emerald' ? 'border-l-2 border-l-emerald-500'
    : accent === 'amber' ? 'border-l-2 border-l-amber-500'
    : accent === 'cyan' ? 'border-l-2 border-l-cyan-500'
    : accent === 'purple' ? 'border-l-2 border-l-purple-500'
    : accent === 'red' ? 'border-l-2 border-l-red-500' : '';
  const accentText = accent === 'emerald' ? 'text-emerald-400'
    : accent === 'amber' ? 'text-amber-400'
    : accent === 'cyan' ? 'text-cyan-400'
    : accent === 'purple' ? 'text-purple-400'
    : accent === 'red' ? 'text-red-400' : 'text-zinc-100';
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
    emerald: 'text-emerald-400', red: 'text-red-400',
    amber: 'text-amber-400', cyan: 'text-cyan-400', purple: 'text-purple-400',
  };
  return (
    <div className="flex justify-between items-center">
      <span className="text-zinc-500">{label}</span>
      <span className={`${accent ? colors[accent] : 'text-zinc-200'} ${bold ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
}

// Hover tooltip wrapper
function InfoIcon({ tip }) {
  return (
    <span className="relative inline-block group cursor-help">
      <Info size={11} className="text-zinc-500 hover:text-zinc-300" />
      <span className="absolute z-20 right-0 top-full mt-1 w-64 p-2 bg-zinc-950 border border-zinc-700 rounded shadow-xl text-[10px] text-zinc-300 leading-snug opacity-0 invisible group-hover:opacity-100 group-hover:visible transition pointer-events-none">
        {tip}
      </span>
    </span>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function UKAdvancedFIREPlanner() {
  // Basic
  const [currentAge, setCurrentAge] = useState(29);
  const [retireAge, setRetireAge] = useState(40);
  const pensionAge = 57;

  // Income
  const [baseSalary, setBaseSalary] = useState(71500);
  const [bonusPct, setBonusPct] = useState(15);

  // Savings
  const [personalPct, setPersonalPct] = useState(8);
  const [employerPct, setEmployerPct] = useState(5);
  const [monthlyISA, setMonthlyISA] = useState(1500);
  const [currentISA, setCurrentISA] = useState(50000);
  const [currentPension, setCurrentPension] = useState(40000);

  // Macro
  const [nominalReturnISA, setNominalReturnISA] = useState(7);
  const [nominalReturnPension, setNominalReturnPension] = useState(6);
  const [inflation, setInflation] = useState(2.5);
  const [annualExpenses, setAnnualExpenses] = useState(40000);

  // Mode toggles
  const [useCarryForward, setUseCarryForward] = useState(false);

  useEffect(() => {
    if (retireAge <= currentAge) setRetireAge(Math.min(currentAge + 1, pensionAge));
  }, [currentAge]); // eslint-disable-line

  // ---- Build params ----
  const userParams = {
    currentAge, retireAge, pensionAge,
    baseSalary, bonusPct, personalPct, employerPct,
    monthlyISA, currentISA, currentPension,
    nominalReturnISA, nominalReturnPension, inflation, annualExpenses,
  };

  const sim = useMemo(() => simulate(userParams), [
    baseSalary, monthlyISA, currentAge, retireAge, bonusPct,
    personalPct, employerPct, currentISA, currentPension,
    nominalReturnISA, nominalReturnPension, inflation, annualExpenses,
  ]);

  const retirePoint = sim.data.find(d => d.age === retireAge) || { isa: 0, pension: 0, total: 0 };
  const pensionAgePoint = sim.data.find(d => d.age === pensionAge) || { isa: 0, pension: 0, total: 0 };
  const bridgeYears = pensionAge - retireAge;
  const requiredISA = requiredISAforBridge(annualExpenses, sim.realReturnISA, bridgeYears);
  const isaGap = requiredISA - retirePoint.isa;
  const bridgeSecure = isaGap <= 0;

  // Lump sum needed TODAY (PV of gap discounted at ISA real return)
  const yearsToRetire = retireAge - currentAge;
  const lumpSumToday = isaGap > 0
    ? isaGap / Math.pow(1 + sim.realReturnISA, Math.max(1, yearsToRetire))
    : 0;

  // Annual Allowance check
  const aa = checkAnnualAllowance(sim.cashFlow.totalPension, useCarryForward);
  const aaCharge = aa.chargeable
    ? aa.overEffective * (sim.cashFlow.taxableIncome > BASIC_LIMIT ? 0.40 : 0.20)
    : 0;

  // Bridge bar chart data
  const bridgeData = useMemo(
    () => simulateBridgeYearly(retirePoint.isa, retireAge, pensionAge, annualExpenses, sim.realReturnISA),
    [retirePoint.isa, retireAge, pensionAge, annualExpenses, sim.realReturnISA]
  );
  const gapYearCount = bridgeData.filter(d => d.status === 'gap').length;
  const firstGapAge = bridgeData.find(d => d.status === 'gap')?.age;

  // Reverse engineer (surplus model)
  const reverse = useMemo(() => reverseEngineerSalary(userParams), [
    currentAge, retireAge, baseSalary, bonusPct, personalPct, employerPct,
    monthlyISA, currentISA, currentPension,
    nominalReturnISA, nominalReturnPension, inflation, annualExpenses,
  ]);

  const realReturnISApct = (sim.realReturnISA * 100).toFixed(2);
  const realReturnPensionPct = (sim.realReturnPension * 100).toFixed(2);
  const savingsRate = sim.cashFlow.net > 0 ? ((activeMonthlyISA * 12) / sim.cashFlow.net) * 100 : 0;

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
              Real-return engine · UK tax (PA-taper / 20–40–45 / NI / AA-£60k) · ISA-Pension bridge analysis
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <div className="text-zinc-500">REAL_ISA <span className="text-cyan-400">{realReturnISApct}%</span></div>
          <div className="text-zinc-500">REAL_PEN <span className="text-purple-400">{realReturnPensionPct}%</span></div>
          <div className="text-zinc-500">YRS_TO_FIRE <span className="text-emerald-400">{yearsToRetire}</span></div>
          <div className="text-zinc-500">SAV_RATE <span className="text-emerald-400">{savingsRate.toFixed(1)}%</span></div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* =============== LEFT INPUTS =============== */}
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

            {sim.cashFlow.paTapered && (
              <div className="bg-amber-950/20 border border-amber-800/40 rounded p-1.5 flex items-start gap-1.5">
                <AlertCircle size={11} className="text-amber-400 mt-0.5 shrink-0" />
                <div className="text-[10px] text-amber-200/80 leading-snug">
                  <span className="font-bold">PA tapered:</span> {fmtGBP(sim.cashFlow.effectivePA)}
                  {' '}(of £12,570). Marginal rate ≈ 60% in £100k–£125k band.
                </div>
              </div>
            )}
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3 space-y-2.5">
            <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
              <PiggyBank size={12} className="text-emerald-400" /> SAVINGS & INVESTMENT
            </h3>
            <Slider label="Personal Pension % (on base)" value={personalPct} setValue={setPersonalPct}
              min={0} max={40} step={0.5} unit="%" />
            <Slider label="Employer Match %" value={employerPct} setValue={setEmployerPct}
              min={0} max={20} step={0.5} unit="%" />

            {/* Annual Allowance card */}
            <div className={`border rounded p-2 ${aa.chargeable
              ? 'bg-red-950/30 border-red-800/50'
              : aa.breached ? 'bg-amber-950/20 border-amber-800/40' : 'bg-zinc-900/40 border-zinc-800'}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  {aa.chargeable
                    ? <AlertCircle size={11} className="text-red-400" />
                    : aa.breached
                      ? <AlertTriangle size={11} className="text-amber-400" />
                      : <CheckCircle size={11} className="text-emerald-500/70" />}
                  <span className={`text-[10px] font-bold tracking-wider ${aa.chargeable ? 'text-red-400' : aa.breached ? 'text-amber-400' : 'text-zinc-400'}`}>
                    ANNUAL ALLOWANCE
                  </span>
                </div>
                <InfoIcon tip="UK pension Annual Allowance is £60,000/yr for tax-relievable contributions (employee + employer combined). Excess attracts an Annual Allowance Charge at your marginal income tax rate. Carry Forward lets you use unused allowance from the previous 3 tax years (assumed fully unused here)." />
              </div>
              <div className="text-[10px] font-mono space-y-0.5">
                <Row label="Combined contrib." value={fmtGBP(aa.contribution)} />
                <Row label="Base limit" value={fmtGBP(aa.limit)} />
                {useCarryForward && (
                  <Row label="+ Carry forward (3yr)" value={fmtGBP(aa.carryForwardAvailable)} accent="cyan" />
                )}
                <Row label="Effective limit" value={fmtGBP(aa.effectiveLimit)} bold />
                {aa.breached && (
                  <Row
                    label={aa.chargeable ? "AA CHARGE EXPOSURE" : "Above base (covered)"}
                    value={fmtGBP(aa.chargeable ? aa.overEffective : aa.overBase)}
                    accent={aa.chargeable ? 'red' : 'amber'}
                    bold
                  />
                )}
                {aa.chargeable && (
                  <Row label="Estimated tax charge" value={fmtGBP(aaCharge)} accent="red" />
                )}
              </div>
              <div className="mt-1.5 pt-1.5 border-t border-zinc-800/60">
                <Toggle
                  label="Carry Forward Unused (3 yrs)"
                  hint="Assume full £60k × 3 from prior years available."
                  checked={useCarryForward}
                  onChange={setUseCarryForward}
                />
              </div>
            </div>

            <Slider label="Monthly ISA Contribution"
              value={monthlyISA}
              setValue={setMonthlyISA}
              min={0} max={3333} step={50} unit="£"
            />
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

        {/* =============== RIGHT DASHBOARD =============== */}
        <div className="col-span-9 space-y-4">

          {/* KPI strip */}
          <div className="grid grid-cols-6 gap-3">
            <KPI label="TOTAL GROSS"
              value={fmtGBPshort(sim.cashFlow.grossTotal)}
              sub={`Base ${fmtGBPshort(sim.cashFlow.baseSalary)} + Bonus ${fmtGBPshort(sim.cashFlow.bonus)}`}
              icon={Briefcase} />
            <KPI label="INCOME TAX"
              value={fmtGBPshort(sim.cashFlow.tax)}
              sub={`PA ${fmtGBPshort(sim.cashFlow.effectivePA)} ${sim.cashFlow.paTapered ? '· tapered' : ''}`}
              icon={Receipt} accent={sim.cashFlow.paTapered ? 'amber' : null} />
            <KPI label="NATIONAL INS."
              value={fmtGBPshort(sim.cashFlow.ni)}
              sub={`Eff total tax ${(sim.cashFlow.effectiveTaxRate * 100).toFixed(1)}%`}
              icon={Receipt} />
            <KPI label="NET TAKE-HOME"
              value={fmtGBPshort(sim.cashFlow.net)}
              sub={`After pension salary sacrifice`}
              icon={Wallet} accent="emerald" />
            <KPI label="PENSION INFLOW / YR"
              value={fmtGBPshort(sim.cashFlow.totalPension)}
              sub={aa.chargeable ? `OVER AA by ${fmtGBPshort(aa.overEffective)}` : `You ${fmtGBPshort(sim.cashFlow.personalPension)} + Co ${fmtGBPshort(sim.cashFlow.employerPension)}`}
              icon={Lock} accent={aa.chargeable ? 'red' : 'purple'} />
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
                  {' · '}Pension real <span className="font-mono text-purple-400">{realReturnPensionPct}%</span>
                  {' · '}No pension contrib post age <span className="font-mono text-amber-400">{retireAge}</span>
                </p>
              </div>
              <div className="flex items-center gap-3 text-[11px] font-mono text-zinc-400">
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-cyan-400 rounded-full" /> ISA</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-purple-400 rounded-full" /> Pension</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-emerald-400 rounded-full" /> Total</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={sim.data} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="age" stroke="#71717a" tick={{ fontSize: 11 }} />
                <YAxis stroke="#71717a" tick={{ fontSize: 11 }} tickFormatter={fmtGBPshort} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #3f3f46', borderRadius: '4px', fontSize: '12px' }}
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

          {/* BRIDGE BAR CHART + GOAL SEEK */}
          <div className="grid grid-cols-12 gap-4">
            {/* Bridge year-by-year visualization */}
            <div className={`col-span-7 border rounded-lg p-4 ${bridgeSecure
              ? 'bg-emerald-950/10 border-emerald-800/40'
              : 'bg-red-950/10 border-red-800/40'}`}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Layers size={12} className={bridgeSecure ? 'text-emerald-400' : 'text-red-400'} />
                    BRIDGE TRAJECTORY · ISA Balance retire → 57
                  </h3>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    {bridgeSecure
                      ? `ISA self-funds ${bridgeYears} bridge years; surplus ${fmtGBP(-isaGap)}.`
                      : `ISA exhausts at age ${firstGapAge}. ${gapYearCount} gap year(s) before pension unlocks.`}
                  </p>
                </div>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${bridgeSecure
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-red-500/20 text-red-400'}`}>
                  {bridgeSecure ? 'SECURE' : `${gapYearCount} GAP YRS`}
                </span>
              </div>

              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={bridgeData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="age" stroke="#71717a" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={fmtGBPshort} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #3f3f46', borderRadius: '4px', fontSize: '11px' }}
                    itemStyle={{ fontFamily: 'monospace' }}
                    formatter={(v) => [fmtGBP(v), 'ISA Balance']}
                    labelFormatter={(l) => `Age ${l}`}
                  />
                  <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
                  <Bar dataKey="balance" name="ISA">
                    {bridgeData.map((entry, i) => (
                      <Cell key={i} fill={entry.status === 'gap' ? '#ef4444' : '#22d3ee'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              {/* Bridge metrics row */}
              <div className="grid grid-cols-3 gap-2 mt-3 text-[11px] font-mono">
                <div className="bg-zinc-900/60 rounded p-2">
                  <div className="text-[10px] text-zinc-500">REQUIRED @ RETIRE</div>
                  <div className="text-zinc-200 font-bold">{fmtGBP(requiredISA)}</div>
                </div>
                <div className="bg-zinc-900/60 rounded p-2">
                  <div className="text-[10px] text-zinc-500">PROJECTED @ RETIRE</div>
                  <div className={`font-bold ${bridgeSecure ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmtGBP(retirePoint.isa)}
                  </div>
                </div>
                <div className="bg-zinc-900/60 rounded p-2">
                  <div className="text-[10px] text-zinc-500">{bridgeSecure ? 'SURPLUS' : 'GAP @ RETIRE'}</div>
                  <div className={`font-bold ${bridgeSecure ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmtGBP(Math.abs(isaGap))}
                  </div>
                </div>
              </div>

              {!bridgeSecure && lumpSumToday > 0 && (
                <div className="mt-2 bg-red-950/30 border border-red-800/40 rounded p-2.5 flex items-start gap-2">
                  <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="text-[11px] font-bold text-red-400">LUMP SUM NEEDED TODAY</div>
                    <div className="text-2xl font-bold font-mono text-red-300 leading-tight my-0.5">{fmtGBP(lumpSumToday)}</div>
                    <div className="text-[10px] text-zinc-400 leading-snug">
                      One-time injection into ISA today, growing at {realReturnISApct}% real for {yearsToRetire} yrs,
                      to exactly close the bridge gap of {fmtGBP(isaGap)} at retirement.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* GOAL SEEK / REVERSE ENGINEER */}
            <div className="col-span-5 bg-zinc-900/50 border border-zinc-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                  <Crosshair size={12} className="text-emerald-400" />
                  REVERSE ENGINEER
                </h3>
                <span className="text-[10px] font-mono text-zinc-500">
                  surplus model
                </span>
              </div>

              {reverse.unreachable ? (
                <div>
                  <div className="text-2xl font-bold text-red-400 mb-1 flex items-center gap-2">
                    <AlertTriangle size={20} /> UNREACHABLE
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    Bridge gap cannot close even at £1.5M base salary. Lower expenses, retire later, or boost ISA contribution.
                  </div>
                </div>
              ) : (
                <>
                  <div className="text-[11px] text-zinc-400 mb-2">
                    Min base salary above current that closes the gap, with surplus net auto-flowing to ISA.
                  </div>
                  <div className={`text-3xl font-bold font-mono ${reverse.alreadySecure ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {fmtGBP(reverse.required)}
                  </div>
                  <div className={`text-[11px] mt-1 ${reverse.alreadySecure ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {reverse.alreadySecure
                      ? `${fmtGBP(baseSalary - reverse.required)} above min — secure.`
                      : `Need +${fmtGBP(reverse.required - baseSalary)} above current base.`
                    }
                  </div>
                  <div className="mt-3 space-y-1.5 text-[11px] font-mono">
                    <Row label="Current Base Salary" value={fmtGBP(baseSalary)} />
                    <Row label="Required Target Base" value={fmtGBP(reverse.required)} accent="amber" bold />
                    <Row label="Implied Total Gross" value={fmtGBP(reverse.required * (1 + bonusPct / 100))} accent="amber" />
                    <Row label="Delta vs Current"
                      value={(reverse.required >= baseSalary ? '+' : '−') + fmtGBP(Math.abs(reverse.required - baseSalary))}
                      accent={reverse.required >= baseSalary ? 'red' : 'emerald'} />
                    <div className="border-t border-zinc-800 my-1.5" />
                    <Row label="Bridge Gap @ Current"
                      value={fmtGBP(Math.max(0, reverse.currentTrial.gap))}
                      accent={reverse.currentTrial.gap > 0 ? 'red' : 'emerald'} />
                  </div>
                  <div className="mt-3 pt-3 border-t border-zinc-800 text-[10px] text-zinc-500 leading-relaxed">
                    <span className="text-zinc-400">Surplus model:</span> net surplus over current take-home flows into ISA.
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
