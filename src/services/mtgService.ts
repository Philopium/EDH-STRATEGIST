import { GoogleGenAI, Type } from "@google/genai";
import { GameState } from "./simulator";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface CardData {
  name: string;
  mana_cost?: string;
  cmc: number;
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  colors?: string[];
  image_uris?: {
    normal: string;
  };
}

export interface CardSimulationData {
  role: 'ramp' | 'draw' | 'win-con' | 'engine' | 'other';
  priority: number; // 1-10, 10 is highest
  customEffect?: {
    type: 'draw' | 'mana' | 'damage' | 'token' | 'anthem' | 'reduction';
    value: number;
    secondaryValue?: number; // e.g., for tokens: [count, power]
  };
}

export type SimulationPlaybook = Record<string, CardSimulationData>;

export async function fetchCardData(cardNames: string[]): Promise<CardData[]> {
  // Scryfall collection API has a limit of 75 identifiers per request.
  // We need to batch the requests for full EDH decks (100 cards).
  const BATCH_SIZE = 75;
  const allResults: CardData[] = [];
  
  // Clean up names and remove duplicates/empty strings
  const uniqueNames = Array.from(new Set(cardNames.map(n => n.trim()).filter(n => n !== '')));

  for (let i = 0; i < uniqueNames.length; i += BATCH_SIZE) {
    const batch = uniqueNames.slice(i, i + BATCH_SIZE);
    const identifiers = batch.map(name => ({ name }));

    try {
      const response = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Scryfall API error (${response.status}):`, errorText);
        throw new Error(`Failed to fetch from Scryfall: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      if (data.data) {
        allResults.push(...data.data.filter((c: any) => !c.not_found));
      }

      // Add a small delay between batches to respect rate limits if there are multiple batches
      if (i + BATCH_SIZE < uniqueNames.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error('Error fetching card data batch:', error);
      // Continue to next batch or return what we have? 
      // For now, let's rethrow if it's a critical failure but we'll try to return partial results if possible
    }
  }
  
  return allResults;
}

export interface DeckAnalysisResult {
  analysis: string;
  playstyle: {
    aggression: number;
    control: number;
    combo: number;
    resilience: number;
  };
}

export async function analyzeDeckStrategy(deckList: CardData[]): Promise<DeckAnalysisResult | null> {
  // Filter for unique non-land cards to reduce prompt size
  const uniqueNonLands = Array.from(new Map(
    deckList
      .filter(c => !c.type_line.includes('Land'))
      .map(c => [c.name, c])
  ).values());

  const prompt = `Analyze this Magic: The Gathering Commander (EDH) deck list. 
  
  CRITICAL INSTRUCTION: DO NOT just focus on the commander. You must identify ALL alternative win conditions, infinite combos, and critical mass synergies hidden within the 99 cards.
  
  Identify:
  1. Core strategy and alternative win conditions (combos, specific card interactions).
  2. Potential infinite combos or high-synergy interactions in the 99.
  3. Weaknesses (e.g., lack of interaction, mana curve issues).
  4. Recommended playstyle (Aggro, Control, Combo, Midrange).
  
  Deck List:
  ${uniqueNonLands.map(c => `${c.name} (${c.mana_cost || 'No Cost'}) - ${c.type_line}`).join('\n')}
  
  Return ONLY a JSON object with this exact structure:
  {
    "analysis": "Your detailed markdown analysis here...",
    "playstyle": {
      "aggression": 0-100,
      "control": 0-100,
      "combo": 0-100,
      "resilience": 0-100
    }
  }`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      systemInstruction: "You are a world-class Magic: The Gathering Pro Player and EDH specialist. Provide concise, strategic advice.",
      responseMimeType: "application/json",
    },
  });

  try {
    return JSON.parse(response.text);
  } catch (e) {
    console.error("Failed to parse deck strategy:", e);
    return null;
  }
}

export async function getBestMove(state: GameState, deckStrategy: string) {
  const prompt = `You are a Magic: The Gathering Pro. Given the current game state and the deck's strategy, what is the optimal sequence of plays for this turn?
  
  Deck Strategy: ${deckStrategy}
  
  Current State:
  Turn: ${state.turn}
  Hand: ${state.hand.map((c, i) => `[${i}] ${c.name} (${c.mana_cost}) - ${c.type_line}. Text: ${c.oracle_text}`).join('\n')}
  Command Zone: ${state.commandZone.map(c => `${c.name} (${c.mana_cost}) - ${c.type_line}. Current Tax: ${state.commanderTax}`).join('\n')}
  Battlefield: ${state.battlefield.map(c => `${c.name} (${c.type_line}). Text: ${c.oracle_text}`).join('\n')}
  Mana Available: ${state.manaAvailable}/${state.totalMana}
  Opponent Life: ${state.life}
  
  Rules to remember:
  - You can only play one land per turn.
  - Creatures have summoning sickness (cannot attack the turn they are played) unless they have Haste.
  - Prioritize playing cards that lead to combos or your deck's win condition.
  - Consider mana efficiency and board presence.
  - Commander Tax: Each subsequent cast from the command zone costs 2 more mana.
  
  Return a JSON object with:
  {
    "plays": [index1, index2], // indices of cards in hand to play in order
    "castCommander": boolean, // true if the commander should be cast this turn
    "reasoning": "Detailed explanation of why this sequence is optimal, mentioning specific card synergies or combos."
  }`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
    },
  });

  try {
    return JSON.parse(response.text);
  } catch (e) {
    return { plays: [], reasoning: "Failed to parse AI response" };
  }
}

export async function getDeckStrategyGuide(deckList: CardData[]) {
  const prompt = `Create a "Strategy Guide" for this EDH deck. 
  Include:
  1. Primary win condition.
  2. Key combo pieces.
  3. Priority of plays (e.g., "Always play mana rocks first").
  
  Deck List:
  ${deckList.map(c => c.name).join(', ')}
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
  });

  return response.text;
}

export async function generateSimulationPlaybook(deckList: CardData[]): Promise<SimulationPlaybook> {
  // Filter for unique non-land cards to reduce prompt size and speed up analysis
  const uniqueNonLands = Array.from(new Map(
    deckList
      .filter(c => !c.type_line.includes('Land'))
      .map(c => [c.name, c])
  ).values());

  const prompt = `Analyze this Magic: The Gathering Commander (EDH) deck and generate a "Simulation Playbook" in JSON format.
  For each card, identify its role in a goldfish simulation (where there is no opponent interaction).
  
  Roles:
  - ramp: Cards that provide extra mana (rocks, dorks, land fetch).
  - draw: Cards that draw more cards.
  - win-con: Cards that directly lead to winning (massive creatures, combo pieces).
  - engine: Cards that provide ongoing value or synergy.
  - other: Vanilla creatures or utility cards not directly fitting above.
  
  Priority: 1-10 (10 is highest). How early/often should the simulator try to play this?
  
  Custom Effects (Quantifiable ETB or Static effects):
  - type: 'draw' (value = cards)
  - type: 'mana' (value = extra mana per turn)
  - type: 'damage' (value = direct damage to opponent)
  - type: 'token' (value = count, secondaryValue = power of tokens)
  - type: 'anthem' (value = power buff to ALL creatures on your board)
  - type: 'reduction' (value = mana cost reduction for other spells)
  
  Deck List:
  ${uniqueNonLands.map(c => `${c.name} - ${c.type_line}. Text: ${c.oracle_text}`).join('\n')}
  
  Return ONLY a JSON object where keys are card names and values are the simulation data.
  Example:
  {
    "Sol Ring": { "role": "ramp", "priority": 10, "customEffect": { "type": "mana", "value": 2 } },
    "Beastmaster Ascension": { "role": "win-con", "priority": 8, "customEffect": { "type": "anthem", "value": 5 } },
    "Avenger of Zendikar": { "role": "win-con", "priority": 9, "customEffect": { "type": "token", "value": 10, "secondaryValue": 0 } }
  }`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
    },
  });

  try {
    return JSON.parse(response.text);
  } catch (e) {
    console.error("Failed to parse simulation playbook:", e);
    return {};
  }
}

export interface MatchupAnalysisResult {
  predictedWinRateA: number;
  predictedWinRateB: number;
  analysis: string;
}

export async function analyzeMatchup(deckA: CardData[], deckB: CardData[], results: any, nameA: string = "Deck A", nameB: string = "Deck B"): Promise<MatchupAnalysisResult | null> {
  const nonLandsA = Array.from(new Set(deckA.filter(c => !c.type_line.includes('Land')).map(c => c.name))).join(', ');
  const nonLandsB = Array.from(new Set(deckB.filter(c => !c.type_line.includes('Land')).map(c => c.name))).join(', ');

  const prompt = `Analyze this Magic: The Gathering Commander matchup between ${nameA} and ${nameB}.
  
  We ran a 100-game "goldfish" simulation (playing in a vacuum with no interaction).
  Goldfish Results:
  - ${nameA} Avg Winning Turn: ${results.avgTurnA}
  - ${nameB} Avg Winning Turn: ${results.avgTurnB}
  
  HOWEVER, goldfishing ignores interaction, removal, stax, and commanders that rely on opponents (e.g., theft, mill, or graveyard scaling like Umbris).
  
  Look at the actual FULL non-land decklists to understand ALL win conditions, combos, and synergies (CRITICAL: Do NOT just focus on the commander, look for alternative wincons in the 99):
  ${nameA} Decklist: ${nonLandsA}
  ${nameB} Decklist: ${nonLandsB}
  
  Evaluate how these decks will ACTUALLY play against each other in a real 1v1 game. 
  - What are the primary and alternative win conditions for each deck? (e.g., combos in the 99, critical mass synergies).
  - Does the slower deck have enough interaction to stop the faster deck's specific combos/wincons? 
  - Does one deck feed the other's strategy (e.g., mill feeding a graveyard deck)?
  - How do commanders that rely on opponent board states fare in this specific matchup?
  
  Return ONLY a JSON object with this exact structure:
  {
    "predictedWinRateA": 50,
    "predictedWinRateB": 50,
    "analysis": "Your detailed markdown analysis here. Explicitly address the alternative win conditions in the 99 and how their specific interactions match up against the opponent's deck."
  }`;
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      systemInstruction: "You are a world-class Magic: The Gathering Pro Player and EDH specialist.",
      responseMimeType: "application/json",
    },
  });

  try {
    return JSON.parse(response.text);
  } catch (e) {
    console.error("Failed to parse matchup analysis:", e);
    return null;
  }
}

export async function analyzeSimulationResults(results: any[], deckStrategy: string) {
  const prompt = `Analyze these Magic: The Gathering Commander (EDH) goldfish simulation results. 
  
  Deck Strategy: ${deckStrategy}
  
  Simulation Results:
  ${results.map((r, i) => `Run ${i+1}: Turn ${r.turns} Win. Final Mana: ${r.finalMana}. Key cards played: ${r.keyCards.join(', ')}`).join('\n')}
  
  Please provide:
  1. A review of the most common ways the deck won (win conditions/patterns).
  2. An explanation for the "slower wins" (e.g., why some runs took 10+ turns while others took 5).
  3. Strategic advice to improve consistency or speed based on these results.
  
  Be concise but insightful.`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      systemInstruction: "You are a world-class Magic: The Gathering Pro Player and EDH specialist. Provide concise, strategic advice based on simulation data.",
    },
  });

  return response.text;
}
