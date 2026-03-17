import { CardData, SimulationPlaybook } from "./mtgService";

export interface BattlefieldCard extends CardData {
  turnPlayed: number;
}

export type OpponentArchetype = 'goldfish' | 'aggro' | 'control' | 'combo';

export interface GameState {
  turn: number;
  hand: CardData[];
  library: CardData[];
  battlefield: BattlefieldCard[];
  graveyard: CardData[];
  commandZone: CardData[];
  commanderTax: number;
  manaAvailable: number;
  totalMana: number;
  life: number; // Opponent life
  playerLife: number; // Player life
  logs: string[];
}

export class GoldfishSimulator {
  private deck: CardData[];
  private commander: CardData | null = null;
  private playbook: SimulationPlaybook = {};
  private archetype: OpponentArchetype = 'goldfish';

  constructor(deck: CardData[], playbook: SimulationPlaybook = {}, archetype: OpponentArchetype = 'goldfish') {
    if (deck.length === 0) {
      this.deck = [];
      return;
    }
    this.playbook = playbook;
    this.archetype = archetype;

    // Identify commander: 
    // 1. Look for legendary creatures
    // 2. Fallback to the first card if the user says "always the commander"
    const legendaryCreatures = deck.filter(c => c.type_line.includes('Legendary') && c.type_line.includes('Creature'));
    
    if (legendaryCreatures.length > 0) {
      this.commander = legendaryCreatures[0];
      // Remove only one instance of the commander from the deck
      const index = deck.indexOf(this.commander);
      this.deck = [...deck.slice(0, index), ...deck.slice(index + 1)];
    } else {
      // If no legendary creature, assume the first card is the commander (common in simplified lists)
      this.commander = deck[0];
      this.deck = deck.slice(1);
    }
  }

  private shuffle(array: any[]) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  initGame(): GameState {
    let hand: CardData[] = [];
    let library: CardData[] = [];
    let mulligans = 0;

    // Simple Mulligan Rule: Keep if 2-5 lands, otherwise mulligan once.
    const drawHand = (m: number) => {
      const shuffled = this.shuffle([...this.deck]);
      const h = shuffled.splice(0, 7);
      const l = shuffled;
      return { h, l };
    };

    let { h, l } = drawHand(0);
    const landCount = h.filter(c => c.type_line.includes('Land')).length;
    
    if ((landCount < 2 || landCount > 5) && mulligans < 1) {
      mulligans++;
      const secondTry = drawHand(1);
      h = secondTry.h;
      l = secondTry.l;
    }

    return {
      turn: 1,
      hand: h,
      library: l,
      battlefield: [],
      graveyard: [],
      commandZone: this.commander ? [this.commander] : [],
      commanderTax: 0,
      manaAvailable: 1, // Start with 1 mana available for turn 1 land
      totalMana: 0,
      life: 40,
      playerLife: 40,
      logs: [`Game started vs ${this.archetype.toUpperCase()}. ${mulligans > 0 ? 'Mulliganed once. ' : ''}Hand drawn.`]
    };
  }

  nextTurn(state: GameState): GameState {
    const newState: GameState = { 
      ...state, 
      hand: [...state.hand],
      library: [...state.library],
      battlefield: [...state.battlefield],
      logs: [...state.logs] 
    };
    newState.turn += 1;
    
    // Combat Phase (Simplified: all creatures without summoning sickness attack)
    let totalPower = 0;
    
    // Calculate Anthems from Battlefield
    let anthemBuff = 0;
    newState.battlefield.forEach(card => {
      const pb = this.playbook[card.name];
      if (pb?.customEffect?.type === 'anthem') {
        anthemBuff += pb.customEffect.value;
      }
    });

    newState.battlefield.forEach(card => {
      if (card.type_line.includes('Creature') && card.power) {
        const hasHaste = card.oracle_text?.toLowerCase().includes('haste');
        const canAttack = hasHaste || card.turnPlayed < newState.turn;

        if (canAttack) {
          const p = parseInt(card.power, 10);
          if (!isNaN(p)) totalPower += (p + anthemBuff);
        }
      }
    });

    if (totalPower > 0) {
      newState.life -= totalPower;
      newState.logs.push(`Combat: Attacked for ${totalPower} damage. Opponent life: ${newState.life}`);
    }

    // Opponent Actions
    this.applyOpponentAction(newState);

    // Draw
    if (newState.library.length > 0) {
      const card = newState.library.shift()!;
      newState.hand.push(card);
      newState.logs.push(`Turn ${newState.turn}: Drew ${card.name}`);
    } else {
      newState.logs.push(`Turn ${newState.turn}: Decked out!`);
    }

    // Reset Mana
    const lands = newState.battlefield.filter(c => c.type_line.includes('Land'));
    const manaRocks = newState.battlefield.filter(c => 
      !c.type_line.includes('Land') && 
      (c.oracle_text?.toLowerCase().includes('add {') || c.oracle_text?.toLowerCase().includes('add one mana'))
    );
    
    // Custom Mana Effects from Playbook
    let extraMana = 0;
    newState.battlefield.forEach(card => {
      const pb = this.playbook[card.name];
      if (pb?.customEffect?.type === 'mana') {
        extraMana += pb.customEffect.value;
      }
    });
    
    newState.totalMana = lands.length + manaRocks.length + extraMana;
    
    // Calculate sacrifice mana from tokens (Eldrazi Spawns/Scions)
    const sacTokens = newState.battlefield.filter(c => 
      c.type_line.includes('Token') && 
      (c.oracle_text?.toLowerCase().includes('sacrifice this creature: add {c}') || 
       c.oracle_text?.toLowerCase().includes('sacrifice this creature: add 1 mana') ||
       c.name.includes('Eldrazi Spawn') || 
       c.name.includes('Eldrazi Scion'))
    );
    
    newState.manaAvailable = newState.totalMana + sacTokens.length;

    return newState;
  }

  castCommander(state: GameState): GameState {
    if (state.commandZone.length === 0) return state;
    
    const newState: GameState = { 
      ...state, 
      battlefield: [...state.battlefield],
      commandZone: [...state.commandZone],
      logs: [...state.logs] 
    };
    
    // Calculate Cost Reduction
    let reduction = 0;
    newState.battlefield.forEach(card => {
      const pb = this.playbook[card.name];
      if (pb?.customEffect?.type === 'reduction') {
        reduction += pb.customEffect.value;
      }
    });

    const commander = newState.commandZone[0];
    const cost = Math.max(0, commander.cmc + (newState.commanderTax * 2) - reduction);

    if (cost <= newState.manaAvailable) {
      // If cost > current total mana, we need to sacrifice tokens
      const baseMana = newState.totalMana - (state.totalMana - state.manaAvailable);
      if (cost > baseMana) {
        const needed = cost - Math.max(0, baseMana);
        this.sacrificeTokens(newState, needed);
      }
      
      newState.manaAvailable -= cost;
      newState.battlefield.push({ ...commander, turnPlayed: newState.turn });
      newState.commandZone = [];
      newState.commanderTax += 1;
      newState.logs.push(`Turn ${newState.turn}: Cast Commander ${commander.name} for ${cost} mana (Tax: ${newState.commanderTax - 1}, Reduction: ${reduction})`);
    }

    return newState;
  }

  playCard(state: GameState, cardIndex: number): GameState {
    const newState: GameState = { 
      ...state, 
      hand: [...state.hand],
      battlefield: [...state.battlefield],
      logs: [...state.logs] 
    };
    const card = newState.hand[cardIndex];

    if (card.type_line.includes('Land')) {
      const landPlayedThisTurn = newState.logs.some(l => l.includes(`Turn ${newState.turn}: Played Land`));
      if (!landPlayedThisTurn) {
        newState.battlefield.push({ ...card, turnPlayed: newState.turn });
        newState.hand.splice(cardIndex, 1);
        
        const isTapped = card.oracle_text?.toLowerCase().includes('enters the battlefield tapped');
        if (!isTapped) {
          newState.totalMana += 1;
          newState.manaAvailable += 1;
        }
        newState.logs.push(`Turn ${newState.turn}: Played Land - ${card.name}${isTapped ? ' (Tapped)' : ''}`);
      }
    } else {
      // Calculate Cost Reduction
      let reduction = 0;
      newState.battlefield.forEach(c => {
        const pb = this.playbook[c.name];
        if (pb?.customEffect?.type === 'reduction') {
          reduction += pb.customEffect.value;
        }
      });

      const cost = Math.max(0, card.cmc - reduction);

      if (cost <= newState.manaAvailable) {
        // If cost > current total mana, we need to sacrifice tokens
        const baseMana = newState.totalMana - (state.totalMana - state.manaAvailable);
        if (cost > baseMana) {
          const needed = cost - Math.max(0, baseMana);
          this.sacrificeTokens(newState, needed);
        }

        newState.manaAvailable -= cost;
        newState.battlefield.push({ ...card, turnPlayed: newState.turn });
        newState.hand.splice(cardIndex, 1);
        newState.logs.push(`Turn ${newState.turn}: Cast ${card.name} for ${cost} mana (Reduction: ${reduction})`);

        // Effect Handling
        const pb = this.playbook[card.name];
        
        // Custom Effects from Playbook
        if (pb?.customEffect) {
          if (pb.customEffect.type === 'draw') {
            for (let i = 0; i < pb.customEffect.value; i++) {
              if (newState.library.length > 0) {
                const drawn = newState.library.shift()!;
                newState.hand.push(drawn);
                newState.logs.push(`Effect (${card.name}): Drew ${drawn.name}`);
              }
            }
          } else if (pb.customEffect.type === 'damage') {
            newState.life -= pb.customEffect.value;
            newState.logs.push(`Effect (${card.name}): Dealt ${pb.customEffect.value} damage to opponent.`);
          } else if (pb.customEffect.type === 'token') {
            const count = pb.customEffect.value;
            const power = pb.customEffect.secondaryValue || 1;
            for (let i = 0; i < count; i++) {
              newState.battlefield.push({
                name: `${card.name} Token`,
                cmc: 0,
                type_line: 'Token Creature',
                power: power.toString(),
                turnPlayed: newState.turn
              } as any);
            }
            newState.logs.push(`Effect (${card.name}): Created ${count} ${power}/${power} tokens.`);
          }
        }

      // Simple Card Draw Detection (Fallback)
      if (!pb?.customEffect || pb.customEffect.type !== 'draw') {
        const drawMatch = card.oracle_text?.match(/draw (a|one|two|three|\d+) card/i);
        if (drawMatch) {
          let count = 1;
          if (drawMatch[1] === 'two') count = 2;
          if (drawMatch[1] === 'three') count = 3;
          if (!isNaN(parseInt(drawMatch[1]))) count = parseInt(drawMatch[1]);
          
          for (let i = 0; i < count; i++) {
            if (newState.library.length > 0) {
              const drawn = newState.library.shift()!;
              newState.hand.push(drawn);
              newState.logs.push(`Effect: Drew ${drawn.name}`);
            }
          }
        }
      }
    }
  }

  return newState;
}

private applyOpponentAction(state: GameState) {
  switch (this.archetype) {
    case 'aggro':
      // Deals increasing damage starting early
      const aggroDamage = Math.max(0, state.turn * 2 - 1);
      state.playerLife -= aggroDamage;
      state.logs.push(`Opponent (Aggro): Attacked for ${aggroDamage} damage. Your life: ${state.playerLife}`);
      break;
    case 'control':
      // Deals low damage, but occasionally "removes" a random non-land permanent
      const controlDamage = Math.floor(state.turn / 2);
      state.playerLife -= controlDamage;
      if (state.turn % 3 === 0 && state.battlefield.length > 0) {
        const nonLands = state.battlefield.filter(c => !c.type_line.includes('Land'));
        if (nonLands.length > 0) {
          const targetIndex = Math.floor(Math.random() * nonLands.length);
          const target = nonLands[targetIndex];
          const realIndex = state.battlefield.indexOf(target);
          state.battlefield.splice(realIndex, 1);
          state.logs.push(`Opponent (Control): Removed ${target.name}!`);
        }
      }
      state.logs.push(`Opponent (Control): Dealt ${controlDamage} damage. Your life: ${state.playerLife}`);
      break;
    case 'combo':
      // Does nothing until turn 6, then deals massive damage
      if (state.turn >= 6) {
        const comboDamage = 20;
        state.playerLife -= comboDamage;
        state.logs.push(`Opponent (Combo): Combo piece active! Dealt ${comboDamage} damage. Your life: ${state.playerLife}`);
      } else {
        state.logs.push(`Opponent (Combo): Setting up...`);
      }
      break;
  }
}

private sacrificeTokens(state: GameState, count: number) {
  let sacrificed = 0;
  for (let i = state.battlefield.length - 1; i >= 0; i--) {
    if (sacrificed >= count) break;
    const c = state.battlefield[i];
    const isSacToken = c.type_line.includes('Token') && 
      (c.oracle_text?.toLowerCase().includes('sacrifice this creature: add {c}') || 
       c.oracle_text?.toLowerCase().includes('sacrifice this creature: add 1 mana') ||
       c.name.includes('Eldrazi Spawn') || 
       c.name.includes('Eldrazi Scion'));
    
    if (isSacToken) {
      state.battlefield.splice(i, 1);
      sacrificed++;
      state.logs.push(`Effect: Sacrificed ${c.name} for 1 mana.`);
    }
  }
}
}
