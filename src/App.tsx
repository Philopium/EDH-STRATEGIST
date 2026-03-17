import React, { useState, useMemo, useEffect } from 'react';
import { 
  Search, 
  Play, 
  BarChart3, 
  BookOpen, 
  RefreshCw, 
  Trash2, 
  ChevronRight, 
  Dices,
  Info,
  Zap,
  Shield,
  Clock,
  Cpu,
  Trophy,
  History,
  Swords
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  LineChart,
  Line
} from 'recharts';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { 
  fetchCardData, 
  analyzeDeckStrategy, 
  getBestMove, 
  CardData, 
  analyzeSimulationResults,
  generateSimulationPlaybook,
  SimulationPlaybook,
  analyzeMatchup
} from './services/mtgService';
import { GoldfishSimulator, GameState } from './services/simulator';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const COLOR_MAP: Record<string, string> = {
  'W': '#f8f6d3',
  'U': '#0e68ab',
  'B': '#150b00',
  'R': '#d3202a',
  'G': '#00733e',
  'C': '#90adbb',
};

interface SimResult {
  turns: number;
  win: boolean;
  keyCards: string[];
  finalMana: number;
}

const parseDeckList = (raw: string) => {
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l !== '');
  let currentCategory = '';
  return lines.reduce((acc, line) => {
    const cleanLine = line.toLowerCase().replace(/\s*\(\d+\)\s*$/, '').trim();
    const headers = [
      'commander', 'creature', 'creatures', 'artifact', 'artifacts', 
      'planeswalker', 'planeswalkers', 'instant', 'instants', 
      'sorcery', 'sorceries', 'enchantment', 'enchantments', 
      'land', 'lands', 'mainboard', 'sideboard', 'maybeboard', 'deck'
    ];
    if (headers.includes(cleanLine)) {
      currentCategory = cleanLine;
      return acc;
    }

    let quantity = 1;
    let name = line;

    const match = line.match(/^(\d+)[xX]?\s+(.+)$/);
    if (match) {
      quantity = parseInt(match[1], 10);
      name = match[2];
    }

    name = name.split(/[([]/)[0].trim();
    name = name.replace(/\*.*?\*/g, '').trim();

    if (name) {
      acc.push({ quantity, name, isCommander: currentCategory === 'commander' });
    }
    return acc;
  }, [] as { quantity: number, name: string, isCommander: boolean }[]);
};

const buildFullDeck = (parsed: any[], cardDataArray: CardData[]) => {
  const dataLookup: Record<string, CardData> = {};
  cardDataArray.forEach(card => {
    dataLookup[card.name.toLowerCase()] = card;
  });

  const fullDeck: CardData[] = [];
  parsed.forEach(p => {
    const cardData = dataLookup[p.name.toLowerCase()];
    if (cardData) {
      for (let i = 0; i < p.quantity; i++) {
        fullDeck.push(cardData);
      }
    } else {
      const fuzzyMatch = Object.values(dataLookup).find(c => 
        c.name.toLowerCase().includes(p.name.toLowerCase()) || 
        p.name.toLowerCase().includes(c.name.toLowerCase())
      );
      if (fuzzyMatch) {
        for (let i = 0; i < p.quantity; i++) {
          fullDeck.push(fuzzyMatch);
        }
      }
    }
  });
  return fullDeck;
};

export default function App() {
  const [appMode, setAppMode] = useState<'single' | 'versus'>('single');
  const [rawDeckList, setRawDeckList] = useState('');
  const [deck, setDeck] = useState<CardData[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [playstyle, setPlaystyle] = useState<{aggression: number, control: number, combo: number, resilience: number} | null>(null);
  const [playbook, setPlaybook] = useState<SimulationPlaybook>({});
  const [opponentArchetype, setOpponentArchetype] = useState<'goldfish' | 'aggro' | 'control' | 'combo'>('goldfish');
  const [activeTab, setActiveTab] = useState<'input' | 'analysis' | 'playbook' | 'simulator' | 'stats'>('input');
  
  // Simulator State
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [simulator, setSimulator] = useState<GoldfishSimulator | null>(null);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [aiReasoning, setAiReasoning] = useState<string | null>(null);
  const [simResults, setSimResults] = useState<SimResult[]>([]);
  const [simInsight, setSimInsight] = useState<string | null>(null);
  const [isAnalyzingSim, setIsAnalyzingSim] = useState(false);

  // Versus State
  const [rawDeckListB, setRawDeckListB] = useState('');
  const [deckB, setDeckB] = useState<CardData[]>([]);
  const [commanderA, setCommanderA] = useState<string>("Deck A");
  const [commanderB, setCommanderB] = useState<string>("Deck B");
  const [playbookB, setPlaybookB] = useState<SimulationPlaybook>({});
  const [versusResults, setVersusResults] = useState<{winsA: number, winsB: number, avgTurnA: string, avgTurnB: string} | null>(null);
  const [versusAnalysis, setVersusAnalysis] = useState<{ predictedWinRateA: number, predictedWinRateB: number, analysis: string } | null>(null);

  const handleImport = async () => {
    setIsAnalyzing(true);
    setLoadingStatus("Fetching card data from Scryfall...");
    
    const parsedLines = parseDeckList(rawDeckList);
    const uniqueNames = Array.from(new Set(parsedLines.map(p => p.name)));
    const cardDataArray = await fetchCardData(uniqueNames);
    
    const fullDeck = buildFullDeck(parsedLines, cardDataArray);

    setDeck(fullDeck);
    setIsAnalyzing(false);
    setLoadingStatus(null);
    setPlaystyle(null);
    setActiveTab('analysis');
  };

  const runAiAnalysis = async () => {
    if (deck.length === 0) return;
    setIsAnalyzing(true);
    setLoadingStatus("AI is generating strategic insights & simulation playbook...");
    try {
      const [strategyResult, pb] = await Promise.all([
        analyzeDeckStrategy(deck),
        generateSimulationPlaybook(deck)
      ]);
      if (strategyResult) {
        setAnalysis(strategyResult.analysis);
        setPlaystyle(strategyResult.playstyle);
      } else {
        setAnalysis("No analysis generated.");
        setPlaystyle(null);
      }
      setPlaybook(pb);
    } catch (error) {
      console.error(error);
    } finally {
      setIsAnalyzing(false);
      setLoadingStatus(null);
    }
  };

  const startSimulation = () => {
    if (deck.length === 0) return;
    const sim = new GoldfishSimulator(deck, playbook, opponentArchetype);
    setSimulator(sim);
    setGameState(sim.initGame());
    setActiveTab('simulator');
  };

  const autoPlayTurn = async () => {
    if (!gameState || !simulator || !analysis) return;
    setIsAutoPlaying(true);
    try {
      const move = await getBestMove(gameState, analysis);
      setAiReasoning(move.reasoning);
      let currentState = { ...gameState };
      
      // Play cards suggested by AI
      if (move.plays && move.plays.length > 0) {
        // Sort indices descending to avoid splice issues
        const sortedIndices = [...move.plays].sort((a, b) => b - a);
        for (const idx of sortedIndices) {
          if (currentState.hand[idx]) {
            currentState = simulator.playCard(currentState, idx);
          }
        }
      }

      // Cast commander if suggested
      if (move.castCommander) {
        currentState = simulator.castCommander(currentState);
      }
      
      // End turn
      const nextState = simulator.nextTurn(currentState);
      setGameState(nextState);
    } catch (error) {
      console.error(error);
    } finally {
      setIsAutoPlaying(false);
    }
  };

  const runBulkSim = async (count: number = 5) => {
    if (deck.length === 0) return;
    setIsAutoPlaying(true);
    setSimInsight(null);
    
    const BATCH_SIZE = 10;
    let results: SimResult[] = [];
    
    for (let b = 0; b < count; b += BATCH_SIZE) {
      const currentBatchSize = Math.min(BATCH_SIZE, count - b);
      
      for (let i = 0; i < currentBatchSize; i++) {
        const sim = new GoldfishSimulator(deck, playbook, opponentArchetype);
        let state = sim.initGame();
        let turns = 0;
        const keyCards: string[] = [];

        while (state.life > 0 && state.playerLife > 0 && turns < 20) {
          turns++;
          // Heuristic: Play land if available
          const landIdx = state.hand.findIndex(c => c.type_line.includes('Land'));
          if (landIdx !== -1) {
            state = sim.playCard(state, landIdx);
          }

          // Heuristic: Cast commander if possible and mana is high
          if (state.commandZone.length > 0) {
            const commander = state.commandZone[0];
            const cost = commander.cmc + (state.commanderTax * 2);
            if (cost <= state.manaAvailable) {
              state = sim.castCommander(state);
              keyCards.push(commander.name);
            }
          }

          // Heuristic: Play cards using Playbook Priority
          let playable = state.hand
            .map((c, idx) => ({ ...c, originalIdx: idx }))
            .filter(c => !c.type_line.includes('Land') && c.cmc <= state.manaAvailable)
            .sort((a, b) => {
              const pbA = playbook[a.name];
              const pbB = playbook[b.name];
              
              // If we have playbook data, use priority
              if (pbA && pbB) {
                return pbB.priority - pbA.priority;
              }
              
              // Fallback to old logic
              const aIsRock = a.oracle_text?.toLowerCase().includes('add {') || a.oracle_text?.toLowerCase().includes('add one mana');
              const bIsRock = b.oracle_text?.toLowerCase().includes('add {') || b.oracle_text?.toLowerCase().includes('add one mana');
              
              if (turns < 5) {
                if (aIsRock && !bIsRock) return -1;
                if (!aIsRock && bIsRock) return 1;
              }
              return b.cmc - a.cmc;
            });

          while (playable.length > 0) {
            const card = playable[0];
            state = sim.playCard(state, card.originalIdx);
            keyCards.push(card.name);
            
            // Re-filter playable
            playable = state.hand
              .map((c, idx) => ({ ...c, originalIdx: idx }))
              .filter(c => !c.type_line.includes('Land') && c.cmc <= state.manaAvailable)
              .sort((a, b) => {
                const pbA = playbook[a.name];
                const pbB = playbook[b.name];
                
                if (pbA && pbB) {
                  return pbB.priority - pbA.priority;
                }

                const aIsRock = a.oracle_text?.toLowerCase().includes('add {') || a.oracle_text?.toLowerCase().includes('add one mana');
                const bIsRock = b.oracle_text?.toLowerCase().includes('add {') || b.oracle_text?.toLowerCase().includes('add one mana');
                
                if (turns < 5) {
                  if (aIsRock && !bIsRock) return -1;
                  if (!aIsRock && bIsRock) return 1;
                }
                return b.cmc - a.cmc;
              });
          }

          state = sim.nextTurn(state);
        }
        results.push({ 
          turns, 
          win: state.life <= 0 && state.playerLife > 0, 
          keyCards: Array.from(new Set(keyCards)),
          finalMana: state.totalMana
        });
      }
      
      // Give UI a chance to breathe
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    const newResults = [...simResults, ...results];
    setSimResults(newResults);
    setIsAutoPlaying(false);
    setActiveTab('stats');

    // Generate qualitative analysis if analysis is available
    if (newResults.length > 0 && analysis) {
      setIsAnalyzingSim(true);
      try {
        const insight = await analyzeSimulationResults(newResults, analysis);
        setSimInsight(insight);
      } catch (err) {
        console.error("Failed to analyze simulation results:", err);
      } finally {
        setIsAnalyzingSim(false);
      }
    }
  };

  const runVersusMatchup = async () => {
    if (!rawDeckList.trim() || !rawDeckListB.trim()) return;
    setIsAnalyzing(true);
    setLoadingStatus("Parsing decks and fetching card data...");
    
    const parsedA = parseDeckList(rawDeckList);
    const parsedB = parseDeckList(rawDeckListB);
    const uniqueA = Array.from(new Set(parsedA.map(p => p.name)));
    const uniqueB = Array.from(new Set(parsedB.map(p => p.name)));
    
    const [cardsA, cardsB] = await Promise.all([
      fetchCardData(uniqueA),
      fetchCardData(uniqueB)
    ]);
    
    const fullDeckA = buildFullDeck(parsedA, cardsA);
    const fullDeckB = buildFullDeck(parsedB, cardsB);
    setDeck(fullDeckA);
    setDeckB(fullDeckB);

    const getCmdr = (deck: CardData[], parsed: any[], defaultName: string) => {
      const cmdrParsed = parsed.find(p => p.isCommander);
      if (cmdrParsed) {
        const match = deck.find(c => c.name.toLowerCase() === cmdrParsed.name.toLowerCase());
        if (match) return match.name;
        return cmdrParsed.name;
      }
      const leg = deck.find(c => c.type_line.includes('Legendary Creature') || c.type_line.includes('Legendary Planeswalker'));
      return leg ? leg.name : defaultName;
    };

    const nameA = getCmdr(fullDeckA, parsedA, "Deck A");
    const nameB = getCmdr(fullDeckB, parsedB, "Deck B");
    setCommanderA(nameA);
    setCommanderB(nameB);
    
    setLoadingStatus("Generating Simulation Playbooks...");
    const [pbA, pbB] = await Promise.all([
      generateSimulationPlaybook(fullDeckA),
      generateSimulationPlaybook(fullDeckB)
    ]);
    setPlaybook(pbA);
    setPlaybookB(pbB);
    
    setLoadingStatus("Running 100 Matchup Simulations...");
    let winsA = 0;
    let winsB = 0;
    let turnsA: number[] = [];
    let turnsB: number[] = [];
    
    const playTurn = (sim: GoldfishSimulator, state: GameState, pb: SimulationPlaybook) => {
      let s = { ...state };
      const landIdx = s.hand.findIndex(c => c.type_line.includes('Land'));
      if (landIdx !== -1) s = sim.playCard(s, landIdx);
      if (s.commandZone.length > 0) {
        const cost = s.commandZone[0].cmc + (s.commanderTax * 2);
        if (cost <= s.manaAvailable) s = sim.castCommander(s);
      }
      let playable = s.hand.map((c, i) => ({ ...c, originalIdx: i }))
        .filter(c => !c.type_line.includes('Land') && c.cmc <= s.manaAvailable)
        .sort((a, b) => (pb[b.name]?.priority || 0) - (pb[a.name]?.priority || 0) || b.cmc - a.cmc);
      while (playable.length > 0) {
        s = sim.playCard(s, playable[0].originalIdx);
        playable = s.hand.map((c, i) => ({ ...c, originalIdx: i }))
          .filter(c => !c.type_line.includes('Land') && c.cmc <= s.manaAvailable)
          .sort((a, b) => (pb[b.name]?.priority || 0) - (pb[a.name]?.priority || 0) || b.cmc - a.cmc);
      }
      return sim.nextTurn(s);
    };

    // Run 100 races
    for (let i = 0; i < 100; i++) {
      const simA = new GoldfishSimulator(fullDeckA, pbA, 'goldfish');
      const simB = new GoldfishSimulator(fullDeckB, pbB, 'goldfish');
      let stateA = simA.initGame();
      let stateB = simB.initGame();
      
      let turn = 0;
      while (stateA.life > 0 && stateB.life > 0 && turn < 30) {
        turn++;
        stateA = playTurn(simA, stateA, pbA);
        stateB.playerLife = stateA.life;
        if (stateA.life <= 0) { winsA++; turnsA.push(turn); break; }
        
        stateB = playTurn(simB, stateB, pbB);
        stateA.playerLife = stateB.life;
        if (stateB.life <= 0) { winsB++; turnsB.push(turn); break; }
      }
    }
    
    const avgA = turnsA.length ? (turnsA.reduce((a,b)=>a+b,0)/turnsA.length).toFixed(1) : "N/A";
    const avgB = turnsB.length ? (turnsB.reduce((a,b)=>a+b,0)/turnsB.length).toFixed(1) : "N/A";
    const results = { winsA, winsB, avgTurnA: avgA, avgTurnB: avgB };
    setVersusResults(results);
    
    setLoadingStatus("AI is analyzing the matchup results...");
    const analysisResult = await analyzeMatchup(fullDeckA, fullDeckB, results, nameA, nameB);
    setVersusAnalysis(analysisResult);
    setIsAnalyzing(false);
    setLoadingStatus(null);
  };

  const manaCurveData = useMemo(() => {
    const counts: Record<number, number> = {};
    deck.forEach(card => {
      if (card.type_line.includes('Land')) return;
      const cmc = Math.min(card.cmc, 7);
      counts[cmc] = (counts[cmc] || 0) + 1;
    });
    return Array.from({ length: 8 }, (_, i) => ({
      name: i === 7 ? '7+' : i.toString(),
      count: counts[i] || 0
    }));
  }, [deck]);

  const colorData = useMemo(() => {
    const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    deck.forEach(card => {
      if (card.colors && card.colors.length > 0) {
        card.colors.forEach(c => {
          counts[c] = (counts[c] || 0) + 1;
        });
      } else if (!card.type_line.includes('Land')) {
        counts['C'] = (counts['C'] || 0) + 1;
      }
    });
    return Object.entries(counts)
      .filter(([_, count]) => count > 0)
      .map(([name, value]) => ({ name, value }));
  }, [deck]);

  const statsData = useMemo(() => {
    const turnCounts: Record<number, number> = {};
    simResults.forEach(r => {
      if (r.win) {
        turnCounts[r.turns] = (turnCounts[r.turns] || 0) + 1;
      }
    });
    return Object.entries(turnCounts).map(([turn, count]) => ({
      turn: parseInt(turn),
      count
    })).sort((a, b) => a.turn - b.turn);
  }, [simResults]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-950/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
              <Zap className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">EDH STRATEGIST</h1>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Advanced Deck Simulation</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button 
              onClick={() => setAppMode('single')}
              className={cn("px-4 py-1.5 rounded-full text-xs font-bold transition-all", appMode === 'single' ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-zinc-500 hover:text-zinc-300")}
            >
              Single Deck
            </button>
            <button 
              onClick={() => setAppMode('versus')}
              className={cn("px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-2", appMode === 'versus' ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" : "text-zinc-500 hover:text-zinc-300")}
            >
              <Swords className="w-3 h-3" />
              Deck vs Deck
            </button>
          </div>

          {appMode === 'single' && (
            <nav className="flex items-center gap-1 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800">
              <TabButton 
                active={activeTab === 'input'} 
                onClick={() => setActiveTab('input')}
                icon={<BookOpen className="w-4 h-4" />}
                label="Deck List"
              />
              <TabButton 
                active={activeTab === 'analysis'} 
                onClick={() => setActiveTab('analysis')}
                icon={<BarChart3 className="w-4 h-4" />}
                label="Analysis"
                disabled={deck.length === 0}
              />
              <TabButton 
                active={activeTab === 'playbook'} 
                onClick={() => setActiveTab('playbook')}
                icon={<Cpu className="w-4 h-4" />}
                label="Playbook"
                disabled={Object.keys(playbook).length === 0}
              />
              <TabButton 
                active={activeTab === 'simulator'} 
                onClick={() => setActiveTab('simulator')}
                icon={<Dices className="w-4 h-4" />}
                label="Simulator"
                disabled={deck.length === 0}
              />
              <TabButton 
                active={activeTab === 'stats'} 
                onClick={() => setActiveTab('stats')}
                icon={<History className="w-4 h-4" />}
                label="Statistics"
                disabled={simResults.length === 0}
              />
            </nav>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full p-6">
        {appMode === 'single' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Sidebar / Left Column */}
            <div className="lg:col-span-4 space-y-6">
          {activeTab === 'input' ? (
            <div className="glass-panel p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2">
                  <Search className="w-4 h-4 text-emerald-400" />
                  Import Deck
                </h2>
                <span className="text-[10px] font-mono text-zinc-500">MTG Arena / Text Format</span>
              </div>
              <textarea
                value={rawDeckList}
                onChange={(e) => setRawDeckList(e.target.value)}
                placeholder="1 Sol Ring&#10;1 Arcane Signet&#10;1 Command Tower..."
                className="w-full h-[400px] bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all custom-scrollbar"
              />
              <button
                onClick={handleImport}
                disabled={isAnalyzing || !rawDeckList.trim()}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-900/20"
              >
                {isAnalyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                {isAnalyzing ? "Processing..." : "Analyze Deck List"}
              </button>
              {loadingStatus && (
                <div className="flex items-center gap-2 text-[10px] text-emerald-400 font-mono animate-pulse">
                  <Zap className="w-3 h-3" />
                  {loadingStatus}
                </div>
              )}
            </div>
          ) : (
            <div className="glass-panel p-6 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Deck Stats</h2>
                <span className="text-xs font-mono text-emerald-400">{deck.length} Cards</span>
              </div>
              
              <div className="space-y-4">
                <div className="h-48 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={manaCurveData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis dataKey="name" stroke="#71717a" fontSize={10} />
                      <YAxis stroke="#71717a" fontSize={10} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', borderRadius: '8px' }}
                        itemStyle={{ color: '#10b981' }}
                      />
                      <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <p className="text-[10px] text-center text-zinc-500 mt-2 uppercase tracking-widest font-mono">Mana Curve (CMC)</p>
                </div>

                <div className="h-48 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={colorData}
                        cx="50%"
                        cy="50%"
                        innerRadius={40}
                        outerRadius={60}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {colorData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLOR_MAP[entry.name] || '#90adbb'} />
                        ))}
                      </Pie>
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', borderRadius: '8px' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <p className="text-[10px] text-center text-zinc-500 mt-2 uppercase tracking-widest font-mono">Color Distribution</p>
                </div>
              </div>

              <button
                onClick={() => {
                  setDeck([]);
                  setRawDeckList('');
                  setAnalysis(null);
                  setPlaystyle(null);
                  setGameState(null);
                  setSimResults([]);
                  setActiveTab('input');
                }}
                className="w-full py-2 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition-all"
              >
                <Trash2 className="w-3 h-3" />
                Reset Deck
              </button>
            </div>
          )}
        </div>

        {/* Main Content Area */}
        <div className="lg:col-span-8 space-y-6">
          {activeTab === 'input' && (
            <div className="glass-panel p-12 flex flex-col items-center justify-center text-center space-y-6">
              <div className="w-20 h-20 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800">
                <BookOpen className="w-10 h-10 text-zinc-600" />
              </div>
              <div className="max-w-md">
                <h3 className="text-xl font-bold mb-2">Ready to Strategize?</h3>
                <p className="text-zinc-500 text-sm">
                  Paste your Commander deck list in the sidebar to begin. We'll analyze your mana curve, color balance, and simulate playtests against different archetypes.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="space-y-6">
              <div className="glass-panel p-6">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Zap className="w-5 h-5 text-emerald-400" />
                    AI Strategic Insights
                  </h2>
                  <button
                    onClick={runAiAnalysis}
                    disabled={isAnalyzing}
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all"
                  >
                    <RefreshCw className={cn("w-3 h-3", isAnalyzing && "animate-spin")} />
                    {isAnalyzing ? "Analyzing..." : (analysis ? "Refresh Deep Analysis" : "Generate Deep Analysis & Sim Playbook")}
                  </button>
                </div>

                {loadingStatus && (
                  <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center gap-3 text-xs text-emerald-400 font-mono animate-pulse">
                    <Zap className="w-4 h-4" />
                    {loadingStatus}
                  </div>
                )}

                {analysis ? (
                  <div className="prose prose-invert prose-sm max-w-none prose-emerald">
                    <Markdown>{analysis}</Markdown>
                  </div>
                ) : (
                  <div className="py-20 flex flex-col items-center justify-center text-zinc-600 border-2 border-dashed border-zinc-800 rounded-xl">
                    <Info className="w-8 h-8 mb-2 opacity-20" />
                    <p className="text-sm">Click 'Generate Analysis' to get AI-powered deck advice.</p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="glass-panel p-6">
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-blue-400" />
                    Recommended Playstyle
                  </h3>
                  <div className="space-y-3">
                    <PlaystyleItem label="Aggression" value={playstyle?.aggression || 0} color="bg-red-500" />
                    <PlaystyleItem label="Control" value={playstyle?.control || 0} color="bg-blue-500" />
                    <PlaystyleItem label="Combo Potential" value={playstyle?.combo || 0} color="bg-purple-500" />
                    <PlaystyleItem label="Resilience" value={playstyle?.resilience || 0} color="bg-emerald-500" />
                  </div>
                </div>
                <div className="glass-panel p-6 flex flex-col justify-center items-center text-center">
                  <h3 className="font-semibold mb-4">Start Goldfishing</h3>
                  <p className="text-xs text-zinc-500 mb-6">Test your opening hands and mana development in a simulated environment.</p>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest text-center">Opponent Archetype</label>
                      <select 
                        value={opponentArchetype}
                        onChange={(e) => setOpponentArchetype(e.target.value as any)}
                        className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all"
                      >
                        <option value="goldfish">Goldfish (Dummy)</option>
                        <option value="aggro">Aggro (Fast Damage)</option>
                        <option value="control">Control (Removal/Slow)</option>
                        <option value="combo">Combo (Turn 6 Burst)</option>
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={startSimulation}
                        disabled={!deck || isAutoPlaying}
                        className="flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-900/20 disabled:opacity-50"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        Manual Sim
                      </button>
                      <button
                        onClick={() => runBulkSim(10)}
                        disabled={!deck || isAutoPlaying}
                        className="flex-1 px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-full font-bold flex items-center justify-center gap-2 transition-all border border-zinc-700 disabled:opacity-50"
                      >
                        <Cpu className="w-4 h-4" />
                        Run 10
                      </button>
                      <button
                        onClick={() => runBulkSim(100)}
                        disabled={!deck || isAutoPlaying}
                        className="flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-900/20 disabled:opacity-50"
                      >
                        <Zap className="w-4 h-4" />
                        Run 100
                      </button>
                    </div>
                  </div>
                  {Object.keys(playbook).length > 0 && (
                    <div className="mt-4 flex items-center gap-2 text-[10px] text-emerald-400 font-mono bg-emerald-400/10 px-3 py-1 rounded-full border border-emerald-400/20">
                      <Zap className="w-3 h-3" />
                      ENHANCED SIMULATION ACTIVE: {Object.keys(playbook).length} CARDS ANALYZED
                    </div>
                  )}
                  {Object.keys(playbook).length === 0 && analysis && (
                    <div className="mt-4 flex items-center gap-2 text-[10px] text-zinc-500 font-mono">
                      <Info className="w-3 h-3" />
                      Run "Generate Analysis" to enable Deep Simulation accuracy.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'playbook' && (
            <div className="space-y-6">
              <div className="glass-panel p-6">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Cpu className="w-5 h-5 text-emerald-400" />
                    Simulation Playbook
                  </h2>
                  <p className="text-xs text-zinc-500 max-w-md text-right">
                    This is how the AI has interpreted your cards for the "Goldfish" simulation. 
                    It identifies roles, priorities, and quantifiable effects.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {Object.entries(playbook).map(([name, data]) => (
                    <div key={name} className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl hover:border-zinc-700 transition-all">
                      <div className="flex justify-between items-start mb-2">
                        <h4 className="font-bold text-sm truncate pr-2">{name}</h4>
                        <span className={cn(
                          "text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider",
                          data.role === 'ramp' && "bg-emerald-500/10 text-emerald-400",
                          data.role === 'draw' && "bg-blue-500/10 text-blue-400",
                          data.role === 'win-con' && "bg-red-500/10 text-red-400",
                          data.role === 'engine' && "bg-purple-500/10 text-purple-400",
                          data.role === 'other' && "bg-zinc-500/10 text-zinc-400",
                        )}>
                          {data.role}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-[10px] text-zinc-500 font-mono">
                        <div className="flex items-center gap-1">
                          <Zap className="w-3 h-3 text-yellow-500" />
                          Priority: {data.priority}/10
                        </div>
                        {data.customEffect && (
                          <div className="flex items-center gap-1 text-emerald-400">
                            <Info className="w-3 h-3" />
                            {data.customEffect.type.toUpperCase()}: {data.customEffect.value}
                            {data.customEffect.secondaryValue !== undefined && ` / ${data.customEffect.secondaryValue}`}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'simulator' && gameState && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Game Info */}
                <div className="lg:col-span-1 space-y-6">
                  <div className="glass-panel p-6">
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Turn Counter</span>
                      <span className="text-2xl font-bold text-emerald-400">{gameState.turn}</span>
                    </div>
                    <div className="space-y-4">
                      <div className="flex justify-between text-sm">
                        <span className="text-zinc-500">Mana Available</span>
                        <span className="font-mono">{gameState.manaAvailable} / {gameState.totalMana}</span>
                      </div>
                      <div className="w-full h-2 bg-zinc-950 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-emerald-500 transition-all duration-500" 
                          style={{ width: `${(gameState.manaAvailable / Math.max(gameState.totalMana, 1)) * 100}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-zinc-500">Opponent Life</span>
                        <span className="font-mono text-red-400">{gameState.life}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-zinc-500">Your Life</span>
                        <span className="font-mono text-emerald-400">{gameState.playerLife}</span>
                      </div>
                    </div>
                  </div>

                    <div className="glass-panel p-6">
                    <h3 className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">Command Zone</h3>
                    <div className="space-y-4">
                      {gameState.commandZone.length > 0 ? (
                        gameState.commandZone.map((card, i) => (
                          <button
                            key={i}
                            onClick={() => setGameState(simulator!.castCommander(gameState))}
                            className="w-full group relative aspect-[3/4] bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden hover:border-emerald-500 transition-all"
                          >
                            {card.image_uris ? (
                              <img src={card.image_uris.normal} alt={card.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="p-2 flex flex-col h-full text-left">
                                <span className="text-[10px] font-bold leading-tight">{card.name}</span>
                                <span className="text-[8px] text-zinc-500 mt-auto">{card.mana_cost}</span>
                              </div>
                            )}
                            <div className="absolute inset-0 bg-emerald-500/20 opacity-0 group-hover:opacity-100 flex items-center justify-center">
                              <span className="text-[10px] font-bold text-white bg-emerald-600 px-2 py-1 rounded">CAST</span>
                            </div>
                            <div className="absolute top-2 right-2 px-2 py-1 bg-black/80 rounded text-[8px] font-mono text-zinc-400">
                              Tax: {gameState.commanderTax * 2}
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="py-10 flex flex-col items-center justify-center text-zinc-700 border border-dashed border-zinc-800 rounded-lg">
                          <Shield className="w-6 h-6 mb-2 opacity-20" />
                          <p className="text-[10px]">Empty</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="glass-panel p-6 flex-1 flex flex-col min-h-[300px]">
                      <h3 className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">Game Log</h3>
                      <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar text-[11px] font-mono">
                        {gameState.logs.map((log, i) => (
                          <div key={i} className="text-zinc-400 border-l border-zinc-800 pl-2 py-1">
                            {log}
                          </div>
                        ))}
                      </div>
                    </div>

                    {aiReasoning && (
                      <div className="glass-panel p-4 bg-emerald-900/10 border border-emerald-500/20">
                        <div className="flex items-center gap-2 mb-2">
                          <Cpu className="w-3 h-3 text-emerald-400" />
                          <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">AI Reasoning</span>
                        </div>
                        <p className="text-[11px] text-zinc-300 italic leading-relaxed">"{aiReasoning}"</p>
                      </div>
                    )}
                  </div>

                {/* Game Board */}
                <div className="lg:col-span-2 space-y-6">
                  <div className="glass-panel p-6 min-h-[400px]">
                    <div className="flex items-center justify-between mb-6">
                      <h3 className="font-semibold">Battlefield</h3>
                      <div className="flex gap-2">
                        <button 
                          onClick={autoPlayTurn}
                          disabled={isAutoPlaying || !analysis}
                          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold rounded-lg flex items-center gap-2 transition-all border border-zinc-700 disabled:opacity-50"
                        >
                          <Cpu className={cn("w-3 h-3", isAutoPlaying && "animate-spin")} />
                          AI Move
                        </button>
                        <button 
                          onClick={() => setGameState(simulator!.nextTurn(gameState))}
                          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg flex items-center gap-2 transition-all"
                        >
                          Next Turn
                        </button>
                        <button 
                          onClick={startSimulation}
                          className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg transition-all"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-3 md:grid-cols-4 gap-4">
                      {gameState.battlefield.map((card, i) => (
                        <div key={i} className="group relative aspect-[3/4] bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden hover:border-emerald-500/50 transition-all">
                          {card.image_uris ? (
                            <img src={card.image_uris.normal} alt={card.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="p-2 flex flex-col h-full">
                              <span className="text-[10px] font-bold leading-tight">{card.name}</span>
                              <span className="text-[8px] text-zinc-500 mt-auto">{card.type_line}</span>
                            </div>
                          )}
                        </div>
                      ))}
                      {gameState.battlefield.length === 0 && (
                        <div className="col-span-full py-20 flex flex-col items-center justify-center text-zinc-700">
                          <Shield className="w-8 h-8 mb-2 opacity-20" />
                          <p className="text-xs">Battlefield is empty</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Hand */}
                  <div className="glass-panel p-6">
                    <h3 className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">Your Hand ({gameState.hand.length})</h3>
                    <div className="flex gap-4 overflow-x-auto pb-4 custom-scrollbar">
                      {gameState.hand.map((card, i) => (
                        <button
                          key={i}
                          onClick={() => setGameState(simulator!.playCard(gameState, i))}
                          className="flex-shrink-0 w-24 aspect-[3/4] bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden hover:border-emerald-500 hover:scale-105 transition-all group relative"
                        >
                          {card.image_uris ? (
                            <img src={card.image_uris.normal} alt={card.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="p-2 text-left h-full flex flex-col">
                              <span className="text-[9px] font-bold leading-tight">{card.name}</span>
                              <span className="text-[8px] text-zinc-500 mt-auto">{card.mana_cost || '0'}</span>
                            </div>
                          )}
                          <div className="absolute inset-0 bg-emerald-500/20 opacity-0 group-hover:opacity-100 flex items-center justify-center">
                            <span className="text-[10px] font-bold text-white bg-emerald-600 px-2 py-1 rounded">PLAY</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'stats' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-emerald-500" />
                  Simulation Statistics
                </h2>
                <button
                  onClick={() => {
                    setSimResults([]);
                    setSimInsight(null);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs font-mono text-zinc-400 hover:text-red-400 hover:border-red-900/50 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  CLEAR STATS
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="glass-panel p-6 text-center">
                  <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block mb-2">Avg. Turn to Win</span>
                  <span className="text-4xl font-bold text-emerald-400">
                    {(simResults.filter(r => r.win).reduce((acc, r) => acc + r.turns, 0) / simResults.filter(r => r.win).length || 0).toFixed(1)}
                  </span>
                </div>
                <div className="glass-panel p-6 text-center">
                  <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block mb-2">Win Rate (Goldfish)</span>
                  <span className="text-4xl font-bold text-blue-400">
                    {((simResults.filter(r => r.win).length / Math.max(simResults.length, 1)) * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="glass-panel p-6 flex flex-col items-center justify-center gap-2">
                  <div className="flex gap-2 w-full">
                    <button
                      onClick={() => runBulkSim(10)}
                      disabled={!deck || isAutoPlaying}
                      className="flex-1 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-[10px] font-mono text-zinc-400 hover:text-emerald-400 transition-all disabled:opacity-50"
                    >
                      +10 SIMS
                    </button>
                    <button
                      onClick={() => runBulkSim(100)}
                      disabled={!deck || isAutoPlaying}
                      className="flex-1 py-2 bg-emerald-600/10 border border-emerald-500/20 rounded-lg text-[10px] font-mono text-emerald-400 hover:bg-emerald-600/20 transition-all disabled:opacity-50"
                    >
                      +100 SIMS
                    </button>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">Total: {simResults.length}</span>
                </div>
              </div>

              <div className="glass-panel p-6">
                <h3 className="font-semibold mb-6 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-emerald-400" />
                  Turn-to-Win Distribution
                </h3>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={statsData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis dataKey="turn" stroke="#71717a" fontSize={10} label={{ value: 'Turn Number', position: 'insideBottom', offset: -5, fontSize: 10, fill: '#71717a' }} />
                      <YAxis stroke="#71717a" fontSize={10} label={{ value: 'Frequency', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#71717a' }} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', borderRadius: '8px' }}
                      />
                      <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {isAnalyzingSim ? (
                <div className="glass-panel p-8 flex flex-col items-center justify-center gap-4">
                  <RefreshCw className="w-8 h-8 text-emerald-500 animate-spin" />
                  <p className="text-sm font-mono text-zinc-400 animate-pulse">AI is analyzing simulation patterns...</p>
                </div>
              ) : simInsight && (
                <div className="glass-panel p-6 border-l-4 border-l-emerald-500">
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-emerald-400" />
                    Simulation Insight & Analysis
                  </h3>
                  <div className="prose prose-invert prose-sm max-w-none text-zinc-400 font-sans leading-relaxed">
                    <Markdown>{simInsight}</Markdown>
                  </div>
                </div>
              )}

              <div className="glass-panel p-6">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-yellow-400" />
                  Key Cards in Winning Runs
                </h3>
                <div className="flex flex-wrap gap-2">
                  {Array.from(new Set(simResults.flatMap(r => r.keyCards)))
                    .slice(0, 15)
                    .map((card, i) => (
                      <span key={i} className="px-3 py-1 bg-zinc-900 border border-zinc-800 rounded-full text-[10px] font-mono text-zinc-400">
                        {card}
                      </span>
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    ) : (
      <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="glass-panel p-6 space-y-4">
                <h2 className="font-semibold text-emerald-400 flex items-center gap-2">
                  <Shield className="w-4 h-4" />
                  {commanderA}
                </h2>
                <textarea
                  value={rawDeckList}
                  onChange={(e) => setRawDeckList(e.target.value)}
                  placeholder={`Paste ${commanderA} here...`}
                  className="w-full h-[250px] bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all custom-scrollbar"
                />
              </div>
              <div className="glass-panel p-6 space-y-4">
                <h2 className="font-semibold text-blue-400 flex items-center gap-2">
                  <Shield className="w-4 h-4" />
                  {commanderB}
                </h2>
                <textarea
                  value={rawDeckListB}
                  onChange={(e) => setRawDeckListB(e.target.value)}
                  placeholder={`Paste ${commanderB} here...`}
                  className="w-full h-[250px] bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all custom-scrollbar"
                />
              </div>
            </div>
            
            <div className="flex flex-col items-center justify-center gap-4">
              <button
                onClick={runVersusMatchup}
                disabled={isAnalyzing || !rawDeckList.trim() || !rawDeckListB.trim()}
                className="px-8 py-4 bg-gradient-to-r from-emerald-600 to-blue-600 hover:from-emerald-500 hover:to-blue-500 disabled:opacity-50 text-white rounded-full font-bold flex items-center gap-3 transition-all shadow-lg"
              >
                {isAnalyzing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Swords className="w-5 h-5" />}
                {isAnalyzing ? "Simulating Matchup..." : "Run 100 Matchups"}
              </button>
              {loadingStatus && (
                <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono animate-pulse">
                  <Zap className="w-4 h-4 text-yellow-400" />
                  {loadingStatus}
                </div>
              )}
            </div>

            {versusResults && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="glass-panel p-6 flex flex-col items-center justify-center text-center space-y-6">
                  <div className="w-full space-y-4">
                    <h3 className="font-bold text-lg flex items-center justify-center gap-2">
                      <Zap className="w-4 h-4 text-yellow-400" />
                      Goldfish Speed (Vacuum)
                    </h3>
                    <div className="flex w-full h-8 rounded-full overflow-hidden">
                      <div className="bg-emerald-500 flex items-center justify-center text-xs font-bold text-black" style={{ width: `${versusResults.winsA}%` }}>
                        {versusResults.winsA}%
                      </div>
                      <div className="bg-blue-500 flex items-center justify-center text-xs font-bold text-white" style={{ width: `${versusResults.winsB}%` }}>
                        {versusResults.winsB}%
                      </div>
                    </div>
                    <div className="flex justify-between w-full text-xs font-mono">
                      <span className="text-emerald-400">{commanderA} (Avg Turn: {versusResults.avgTurnA})</span>
                      <span className="text-blue-400">{commanderB} (Avg Turn: {versusResults.avgTurnB})</span>
                    </div>
                  </div>

                  {versusAnalysis && (
                    <div className="w-full space-y-4 pt-4 border-t border-zinc-800">
                      <h3 className="font-bold text-lg flex items-center justify-center gap-2">
                        <Cpu className="w-4 h-4 text-purple-400" />
                        AI Prediction (Real Game)
                      </h3>
                      <div className="flex w-full h-8 rounded-full overflow-hidden">
                        <div className="bg-emerald-500 flex items-center justify-center text-xs font-bold text-black" style={{ width: `${versusAnalysis.predictedWinRateA}%` }}>
                          {versusAnalysis.predictedWinRateA}%
                        </div>
                        <div className="bg-blue-500 flex items-center justify-center text-xs font-bold text-white" style={{ width: `${versusAnalysis.predictedWinRateB}%` }}>
                          {versusAnalysis.predictedWinRateB}%
                        </div>
                      </div>
                      <div className="flex justify-between w-full text-xs font-mono">
                        <span className="text-emerald-400">{commanderA}</span>
                        <span className="text-blue-400">{commanderB}</span>
                      </div>
                    </div>
                  )}
                </div>
                
                <div className="lg:col-span-2 glass-panel p-6">
                  <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                    <Swords className="w-5 h-5 text-purple-400" />
                    Interactive Matchup Analysis
                  </h3>
                  <div className="prose prose-invert prose-sm max-w-none">
                    {versusAnalysis ? <Markdown>{versusAnalysis.analysis}</Markdown> : <span className="text-zinc-500">Analyzing...</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-8 bg-zinc-950">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2 opacity-50">
            <Zap className="w-4 h-4" />
            <span className="text-xs font-mono uppercase tracking-widest">MTG EDH Strategist v1.1</span>
          </div>
          <div className="text-[10px] text-zinc-600 font-mono text-center md:text-right">
            Data provided by Scryfall API. Analysis powered by Gemini AI.<br />
            Magic: The Gathering is TM & © Wizards of the Coast.
          </div>
        </div>
      </footer>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, disabled = false }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string, disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold transition-all",
        active 
          ? "bg-zinc-800 text-white shadow-sm" 
          : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50",
        disabled && "opacity-30 cursor-not-allowed"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PlaystyleItem({ label, value, color }: { label: string, value: number, color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono uppercase tracking-wider">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-300">{value}%</span>
      </div>
      <div className="w-full h-1.5 bg-zinc-950 rounded-full overflow-hidden">
        <div 
          className={cn("h-full transition-all duration-1000", color)} 
          style={{ width: `${value}%` }} 
        />
      </div>
    </div>
  );
}

