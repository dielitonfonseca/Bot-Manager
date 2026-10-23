const Vec3 = require('vec3');

class MobFarmerMacro {
  constructor(bot, config, emitLog, sharedStateManager) {
    this.bot = bot;
    this.config = config;
    this.emitLog = emitLog;
    this.sharedState = sharedStateManager;
    this.running = false;
    this.isPaused = false;

    this.MIN_DURABILITY_THRESHOLD = 120; // Limiar de segurança para troca
    this.accumulatedBalance = 0;        // Saldo individual acumulado da conta
    this.isTransferring = false;         // Trava contra envios simultâneos

    this.lastCommandTime = 0;
    this.lastInventoryCheck = 0;
    this.isHandlingAfk = false;

    this.chatListener = async (message) => {
      const raw = message.toString();
      const clean = raw.replace(/§[0-9a-fk-or]/gi, '').trim();
      const lower = clean
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      // Detecção de kick por AFK
      if (lower.includes('voce ficou afk') || lower.includes('teleportado para um local seguro')) {
        this.emitLog('⚠️ [ANTI-AFK] Kick por AFK detectado! Retornando para /home mob (Sem VIP)...');
        this.handleAfkTeleport();
        return;
      }

      // Detecção de venda de drops
      if (clean.includes('Total recebido:') && clean.includes('Coins')) {
        const match = clean.match(/Total recebido:\s*([\d,\.]+)\s*Coins/i);
        if (match && match[1]) {
          const rawNum = match[1].replace(/,/g, '');
          const val = parseFloat(rawNum);
          if (!isNaN(val)) {
            this.emitLog(`💵 Venda computada: +${val.toFixed(2)} Coins.`);
            this.sharedState.addProfit(this.config.username, val);

            // Acumula no saldo individual desta conta
            this.accumulatedBalance += val;

            // Dispara transferência se atingir 1kk (1.000.000 Coins) e não for a conta Fatal
            if (this.accumulatedBalance >= 1000000 && !this.isTransferring && this.config.username.toLowerCase() !== 'fatal') {
              this.isTransferring = true;
              const amountToSend = Math.floor(this.accumulatedBalance);
              this.emitLog(`💰 Saldo individual acumulou 1kk (${amountToSend} Coins)! Enviando para Fatal em 2 etapas com 1s de intervalo...`);

              try {
                // 1º Envio
                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                this.emitLog(`📤 [1/2] /money pay Fatal ${amountToSend} enviado. Aguardando 1s...`);
                await this.sleep(1000);

                // 2º Envio (confirmação da transação)
                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                this.emitLog(`📤 [2/2] Confirmação enviada! Saldo individual zerado com sucesso.`);
                this.accumulatedBalance = 0;
              } catch (tErr) {
                this.emitLog(`❌ Erro ao transferir money: ${tErr.message}`);
              } finally {
                this.isTransferring = false;
              }
            }
          }
        }
      }
    };
    this.bot.on('messagestr', this.chatListener);
  }

  async start() {
    this.running = true;
    this.isPaused = false;
    this.emitLog('⚔️ Macro Mata Mob sem VIP iniciada (Transferência automática de 1kk ativa)...');

    while (this.running) {
      if (this.isPaused) {
        await this.sleep(1000);
        continue;
      }

      try {
        await this.mainLoop();
      } catch (err) {
        this.emitLog(`⚠️ Erro no ciclo de mobs: ${err.message}. Reiniciando em 3s...`);
        this.stopMovement();
        await this.sleep(3000);
      }
    }
  }

  pause() {
    this.isPaused = true;
    this.stopMovement();
    this.emitLog('⏸️ Macro pausada.');
  }

  resume() {
    this.isPaused = false;
    this.emitLog('▶️ Macro retomada.');
  }

  stop() {
    this.running = false;
    this.isPaused = false;
    this.stopMovement();
    this.bot.removeListener('messagestr', this.chatListener);
    this.emitLog('⏹️ Macro finalizada.');
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stopMovement() {
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sprint', false);
  }

  async sendCommand(cmd, minDelayAfter = 1500) {
    const elapsed = Date.now() - this.lastCommandTime;
    if (elapsed < 2000) {
      await this.sleep(2000 - elapsed);
    }
    this.bot.chat(cmd);
    this.lastCommandTime = Date.now();
    await this.sleep(minDelayAfter);
  }

  async teleportSafe(homeName) {
    this.emitLog(`📍 Solicitando /${homeName}...`);

    let teleportConfirmed = false;
    const confirmListener = (msg) => {
      const text = msg.toString().toLowerCase();
      if (text.includes('teleportado')) {
        teleportConfirmed = true;
      }
    };

    this.bot.on('messagestr', confirmListener);
    await this.sendCommand(`/${homeName}`, 500);

    const startTime = Date.now();
    while (!teleportConfirmed && Date.now() - startTime < 8500) {
      await this.sleep(200);
    }

    this.bot.removeListener('messagestr', confirmListener);

    if (teleportConfirmed) {
      this.emitLog('✅ Teleporte confirmado pelo servidor! Aguardando 2s de estabilização...');
    } else {
      this.emitLog('⏳ Aguardando estabilização física (2s)...');
    }

    await this.sleep(2000);
  }

  async handleAfkTeleport() {
    if (this.isHandlingAfk || !this.running) return;
    this.isHandlingAfk = true;
    this.stopMovement();

    try {
      await this.sleep(1000);
      await this.teleportSafe('home mob');
      await this.ensureUsableSwordOrReplace();
      this.emitLog('✅ Retorno do AFK concluído!');
    } catch (e) {
      this.emitLog(`Erro ao retornar do AFK: ${e.message}`);
    } finally {
      this.isHandlingAfk = false;
    }
  }

  getSwordDurability(item) {
    if (!item) return 0;
    const maxDur = item.maxDurability || 1561;

    let damage = 0;
    if (typeof item.metadata === 'number' && item.metadata > 0) {
      damage = item.metadata;
    } else if (item.nbt && item.nbt.value && item.nbt.value.Damage) {
      damage = item.nbt.value.Damage.value || 0;
    } else if (typeof item.durabilityUsed === 'number') {
      damage = item.durabilityUsed;
    }

    return Math.max(0, maxDur - damage);
  }

  getDiamondSword() {
    const swords = this.bot.inventory.items().filter((i) => i.name === 'diamond_sword');
    if (swords.length === 0) return null;
    swords.sort((a, b) => this.getSwordDurability(b) - this.getSwordDurability(a));
    return swords[0];
  }

  async ensureUsableSwordOrReplace() {
    let held = this.bot.heldItem;

    if (held && held.name === 'diamond_sword' && this.getSwordDurability(held) >= this.MIN_DURABILITY_THRESHOLD) {
      return true;
    }

    const bestSword = this.getDiamondSword();
    if (bestSword && this.getSwordDurability(bestSword) >= this.MIN_DURABILITY_THRESHOLD) {
      try {
        await this.bot.equip(bestSword, 'hand');
        await this.sleep(500);
        return true;
      } catch (e) {}
    }

    this.emitLog('⚠️ Sem espada utilizável na mão. Iniciando conferência e troca...');
    const exchanged = await this.replaceSwordRoutine();
    return exchanged;
  }

  countMobDropPacks() {
    const dropNames = [
      'rotten_flesh', 'bone', 'arrow', 'string', 'spider_eye', 'gunpowder',
      'ender_pearl', 'leather', 'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop',
      'chicken', 'cooked_chicken', 'feather', 'slime_ball', 'ghast_tear', 'blaze_rod'
    ];

    const items = this.bot.inventory.items().filter((i) => dropNames.includes(i.name.toLowerCase()));
    let totalItems = 0;
    for (const it of items) totalItems += it.count;
    return totalItems / 64;
  }

  async checkAndSellDrops(force = false) {
    const packs = this.countMobDropPacks();
    if (force || packs >= 18) {
      this.emitLog(`📦 Limpando drops do inventário (~${packs.toFixed(1)} packs)...`);
      await this.sendCommand('/vender mobs', 1200);
      await this.sleep(800);
      await this.sendCommand('/vender farms', 1200);
      await this.sleep(1000);
    }
  }

  getTargetChest() {
    const lookTarget = this.bot.blockAtCursor(5);
    if (lookTarget && (lookTarget.name === 'chest' || lookTarget.name === 'trapped_chest')) {
      return lookTarget;
    }

    return this.bot.findBlock({
      matching: (block) => block && (block.name === 'chest' || block.name === 'trapped_chest'),
      maxDistance: 4.5
    });
  }

  async replaceSwordRoutine() {
    await this.checkAndSellDrops(true);

    this.emitLog('🔨 [TROCA] Indo até as homes de baú...');
    const homes = ['home fatal repararespadas1', 'home fatal repararespadas2'];
    let swordExchanged = false;

    for (const home of homes) {
      if (swordExchanged || !this.running || this.isPaused) break;

      await this.teleportSafe(home);

      const chestBlock = this.getTargetChest();
      if (!chestBlock) {
        this.emitLog(`❌ [ERRO] Nenhum baú localizado em /${home}. Tentando próxima home...`);
        continue;
      }

      this.emitLog(`👀 Mirando no baú em ${chestBlock.position}...`);
      await this.bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
      await this.sleep(600);

      this.emitLog(`📦 [BAÚ] Abrindo ${home}...`);
      let container = null;
      try {
        container = await this.bot.openContainer(chestBlock);
        await this.sleep(1800);
      } catch (openErr) {
        this.emitLog(`❌ Falha ao abrir baú em /${home}: ${openErr.message}`);
        continue;
      }

      if (!container || !this.bot.currentWindow) {
        this.emitLog(`⚠️ Janela do baú não abriu em /${home}.`);
        continue;
      }

      try {
        // 1. Procura se existem espadas novas no baú (durabilidade >= 1200)
        const freshInChest = [];
        for (let s = 0; s < container.inventoryStart; s++) {
          const item = container.slots[s];
          if (item && item.name === 'diamond_sword' && this.getSwordDurability(item) >= 1200) {
            freshInChest.push({ slot: s, item: item, dur: this.getSwordDurability(item) });
          }
        }

        this.emitLog(`🔍 Espadas NOVAS (>= 1200 dur) em /${home}: ${freshInChest.length}`);

        if (freshInChest.length === 0) {
          this.emitLog(`⚠️ Sem espadas aptas em /${home}. Indo verificar o próximo baú...`);
          if (this.bot.currentWindow) {
            container.close();
          }
          await this.sleep(800);
          continue;
        }

        // 2. Localiza a espada gasta do jogador na janela aberta
        let brokenSwordSlot = null;
        for (let s = container.inventoryStart; s < container.slots.length; s++) {
          const it = container.slots[s];
          if (it && it.name === 'diamond_sword') {
            const d = this.getSwordDurability(it);
            if (d < 500) {
              brokenSwordSlot = s;
              break;
            }
          }
        }

        // 3. Devolve a espada gasta colocando diretamente no primeiro slot livre do baú
        if (brokenSwordSlot !== null) {
          let emptyChestSlot = null;
          for (let s = 0; s < container.inventoryStart; s++) {
            if (!container.slots[s]) {
              emptyChestSlot = s;
              break;
            }
          }

          if (emptyChestSlot !== null) {
            this.emitLog(`📥 [DEVOLUÇÃO] Colocando espada gasta no slot vazio ${emptyChestSlot} do baú...`);
            await this.bot.clickWindow(brokenSwordSlot, 0, 0);
            await this.sleep(600);
            await this.bot.clickWindow(emptyChestSlot, 0, 0);
            await this.sleep(600);
          } else {
            this.emitLog(`📥 [DEVOLUÇÃO] Enviando via Shift-Click do slot ${brokenSwordSlot}...`);
            await this.bot.clickWindow(brokenSwordSlot, 0, 1);
            await this.sleep(600);
          }
        }

        // 4. Retira exatamente UMA espada nova
        const targetNew = freshInChest[0];
        this.emitLog(`🗡️ [RETIRADA] Puxando UMA espada nova do slot ${targetNew.slot} (Dur: ${targetNew.dur})...`);
        await this.bot.clickWindow(targetNew.slot, 0, 1);
        await this.sleep(800);

        swordExchanged = true;
        await this.sharedState.claimNextSwordSlot(this.config.username);

        if (this.bot.currentWindow) {
          container.close();
          await this.sleep(800);
        }

        this.emitLog(`✅ Troca concluída com sucesso em /${home}! Encerrando visita aos baús.`);
        break;
      } catch (err) {
        this.emitLog(`❌ [ERRO NA MANIPULAÇÃO] /${home}: ${err.message}`);
        if (this.bot.currentWindow) {
          try { container.close(); } catch (e) {}
        }
      }
    }

    const currentInventorySword = this.getDiamondSword();
    const hasValidSwordNow = currentInventorySword && this.getSwordDurability(currentInventorySword) >= 1000;

    if (!swordExchanged && !hasValidSwordNow) {
      this.emitLog('❌ Nenhuma espada utilizável encontrada. Pausando para evitar mortes.');
      this.pause();
      return false;
    }

    // 5. Equipa a espada boa na mão
    await this.sleep(500);
    const bestSword = this.getDiamondSword();
    if (bestSword) {
      try {
        await this.bot.equip(bestSword, 'hand');
        await this.sleep(500);
        this.emitLog(`⚔️ [EQUIPADA] Espada pronta na mão! Durabilidade: ${this.getSwordDurability(bestSword)}/1561.`);
      } catch (e) {
        this.emitLog(`⚠️ Erro ao equipar espada: ${e.message}`);
      }
    }

    // 6. Retorna para o mob
    this.emitLog('📍 [RETORNO] Teleportando de volta para /home mob...');
    await this.teleportSafe('home mob');
    this.emitLog('🎯 Chegou no mob! Pronto para abater.');
    return true;
  }

  findNearbyMob() {
    const mobFilter = (e) => {
      if (!e || e === this.bot.entity) return false;
      if (e.type !== 'mob' && e.type !== 'hostile' && e.type !== 'animal') return false;
      if (!e.isValid || e.health <= 0) return false;
      return this.bot.entity.position.distanceTo(e.position) <= 4.2;
    };
    return this.bot.nearestEntity(mobFilter);
  }

  async mainLoop() {
    const hasSword = await this.ensureUsableSwordOrReplace();
    if (!hasSword) return;

    await this.teleportSafe('home mob');
    this.emitLog('🎯 Abatendo mobs continuamente...');

    while (this.running && !this.isPaused) {
      if (this.isHandlingAfk) {
        await this.sleep(1000);
        continue;
      }

      // 1. Verificação prévia da espada na mão
      let currentSword = this.bot.heldItem;
      if (!currentSword || currentSword.name !== 'diamond_sword') {
        const bestInInv = this.getDiamondSword();
        if (bestInInv && this.getSwordDurability(bestInInv) >= this.MIN_DURABILITY_THRESHOLD) {
          try {
            await this.bot.equip(bestInInv, 'hand');
            await this.sleep(400);
            currentSword = this.bot.heldItem;
          } catch (e) {}
        }
      }

      const dur = this.getSwordDurability(currentSword);

      // Gatilho pré-ataque
      if (!currentSword || currentSword.name !== 'diamond_sword' || dur < this.MIN_DURABILITY_THRESHOLD) {
        this.emitLog(`🛡️ [BLINDAGEM] Espada gasta ou ausente (${dur}/1561 < ${this.MIN_DURABILITY_THRESHOLD}). Trocando nos baús...`);
        await this.replaceSwordRoutine();
        continue;
      }

      // 2. Venda periódica
      if (Date.now() - this.lastInventoryCheck >= 10000) {
        await this.checkAndSellDrops(false);
        this.lastInventoryCheck = Date.now();
      }

      // 3. Ataque contínuo com verificação pós-hit imediata
      const mob = this.findNearbyMob();
      if (mob) {
        try {
          await this.bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true);
          this.bot.attack(mob);

          // VERIFICAÇÃO ATÔMICA PÓS-HIT
          const afterHitSword = this.bot.heldItem;
          const afterHitDur = this.getSwordDurability(afterHitSword);

          if (!afterHitSword || afterHitSword.name !== 'diamond_sword' || afterHitDur < this.MIN_DURABILITY_THRESHOLD) {
            this.emitLog(`🛡️ [ALERTA PÓS-HIT] Durabilidade caiu para ${afterHitDur}/1561 logo após o ataque! Trocando nos baús imediatamente...`);
            await this.replaceSwordRoutine();
            continue;
          }

          await this.sleep(400);
        } catch (e) {
          await this.sleep(200);
        }
      } else {
        await this.sleep(250);
      }
    }
  }
}

module.exports = MobFarmerMacro;