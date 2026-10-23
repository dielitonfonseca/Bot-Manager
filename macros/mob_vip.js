const Vec3 = require('vec3');

class MobVipMacro {
  constructor(bot, config, emitLog, sharedStateManager) {
    this.bot = bot;
    this.config = config;
    this.emitLog = emitLog;
    this.sharedState = sharedStateManager;
    this.running = false;
    this.isPaused = false;

    this.PERSONAL_SWORD_SLOT = 9;
    this.MIN_DURABILITY_THRESHOLD = 150;
    this.accumulatedBalance = 0;
    this.isTransferring = false;

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

      if (lower.includes('voce ficou afk') || lower.includes('teleportado para um local seguro')) {
        this.emitLog('⚠️ [ANTI-AFK] Kick por AFK detectado! Retornando ao mob (VIP)...');
        this.handleAfkTeleport();
        return;
      }

      if (clean.includes('Total recebido:') && clean.includes('Coins')) {
        const match = clean.match(/Total recebido:\s*([\d,\.]+)\s*Coins/i);
        if (match && match[1]) {
          const rawNum = match[1].replace(/,/g, '');
          const val = parseFloat(rawNum);
          if (!isNaN(val)) {
            this.emitLog(`💵 Venda computada: +${val.toFixed(2)} Coins.`);
            this.sharedState.addProfit(this.config.username, val);

            this.accumulatedBalance += val;

            if (this.accumulatedBalance >= 1000000 && !this.isTransferring && this.config.username.toLowerCase() !== 'fatal') {
              this.isTransferring = true;
              const amountToSend = Math.floor(this.accumulatedBalance);
              this.emitLog(`💰 [VIP] Saldo atingiu 1kk (${amountToSend} Coins)! Transferindo para Fatal em 2 etapas...`);

              try {
                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                await this.sleep(1000);
                this.bot.chat(`/money pay Fatal ${amountToSend}`);
                this.emitLog(`📤 [VIP] Transferência confirmada! Saldo zerado.`);
                this.accumulatedBalance = 0;
              } catch (tErr) {
                this.emitLog(`❌ Erro na transferência VIP: ${tErr.message}`);
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
    this.emitLog('👑 Macro MOB VIP iniciada...');

    while (this.running) {
      if (this.isPaused) {
        await this.sleep(1000);
        continue;
      }

      try {
        await this.mainLoop();
      } catch (err) {
        this.emitLog(`⚠️ Erro no ciclo VIP: ${err.message}. Reiniciando em 3s...`);
        this.stopMovement();
        await this.sleep(3000);
      }
    }
  }

  pause() {
    this.isPaused = true;
    this.stopMovement();
    this.emitLog('⏸️ Macro VIP pausada.');
  }

  resume() {
    this.isPaused = false;
    this.emitLog('▶️ Macro VIP retomada.');
  }

  stop() {
    this.running = false;
    this.isPaused = false;
    this.stopMovement();
    this.bot.removeListener('messagestr', this.chatListener);
    this.emitLog('⏹️ Macro VIP finalizada.');
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

  async sendCommand(cmd, minDelayAfter = 1200) {
    const elapsed = Date.now() - this.lastCommandTime;
    if (elapsed < 1500) {
      await this.sleep(1500 - elapsed);
    }
    this.bot.chat(cmd);
    this.lastCommandTime = Date.now();
    await this.sleep(minDelayAfter);
  }

  async teleportVip(homeName) {
    this.emitLog(`📍 VIP teleportando para /${homeName}...`);
    await this.sendCommand(`/${homeName}`, 1200);
    await this.sleep(2000);
  }

  async handleAfkTeleport() {
    if (this.isHandlingAfk || !this.running) return;
    this.isHandlingAfk = true;
    this.stopMovement();

    try {
      await this.sleep(1000);
      await this.teleportVip('home mob');
      await this.restorePersonalSwordToHand();
      this.emitLog('✅ Retorno do AFK VIP concluído!');
    } catch (e) {
      this.emitLog(`Erro ao retornar do AFK: ${e.message}`);
    } finally {
      this.isHandlingAfk = false;
    }
  }

  getSwordDurability(sword) {
    if (!sword) return 0;
    const maxDur = sword.maxDurability || 1561;
    let damage = 0;
    if (typeof sword.metadata === 'number' && sword.metadata > 0) {
      damage = sword.metadata;
    } else if (sword.nbt && sword.nbt.value && sword.nbt.value.Damage) {
      damage = sword.nbt.value.Damage.value || 0;
    } else if (typeof sword.durabilityUsed === 'number') {
      damage = sword.durabilityUsed;
    }
    return Math.max(0, maxDur - damage);
  }

  getDiamondSword() {
    const swords = this.bot.inventory.items().filter((i) => i.name === 'diamond_sword');
    if (swords.length === 0) return null;
    swords.sort((a, b) => this.getSwordDurability(b) - this.getSwordDurability(a));
    return swords[0];
  }

  countDiamondBlocks() {
    let count = 0;
    for (const it of this.bot.inventory.items()) {
      if (it && it.name === 'diamond_block') count += it.count;
    }
    return count;
  }

  getEmptySlotsCount() {
    let empty = 0;
    for (let s = 9; s <= 44; s++) {
      if (!this.bot.inventory.slots[s]) empty++;
    }
    return empty;
  }

  countMobDropPacks() {
    const dropNames = [
      'cooked_beef', 'cooked_steak', 'steak', 'beef', 'leather',
      'rotten_flesh', 'bone', 'arrow', 'string', 'spider_eye',
      'gunpowder', 'ender_pearl', 'porkchop', 'cooked_porkchop',
      'chicken', 'cooked_chicken', 'feather', 'slime_ball', 'ghast_tear', 'blaze_rod'
    ];

    let totalItems = 0;
    for (const it of this.bot.inventory.items()) {
      if (it && dropNames.includes(it.name.toLowerCase())) {
        totalItems += it.count;
      }
    }
    return totalItems / 64;
  }

  async checkAndSellDrops() {
    const packs = this.countMobDropPacks();
    const emptySlots = this.getEmptySlotsCount();

    if (packs >= 18 || emptySlots <= 3) {
      this.emitLog(`📦 Condição de venda VIP (~${packs.toFixed(1)} packs / ${emptySlots} slots livres). Vendendo...`);
      await this.sendCommand('/vender farms', 1200);
      await this.sleep(800);
      await this.sendCommand('/vender mobs', 1200);
      await this.sleep(1000);
    }
  }

  getTargetChestInFront() {
    const target = this.bot.blockAtCursor(5);
    if (target && (target.name === 'chest' || target.name === 'trapped_chest')) {
      return target;
    }

    return this.bot.findBlock({
      matching: (b) => b && (b.name === 'chest' || b.name === 'trapped_chest'),
      maxDistance: 4.5
    });
  }

  async ensureDiamondBlocksSupply() {
    if (this.countDiamondBlocks() >= 64) return;

    this.emitLog('📦 Menos de 64 blocos de diamante. Buscando nos baús...');
    await this.checkAndSellDrops();

    for (let i = 1; i <= 10; i++) {
      if (this.countDiamondBlocks() >= 64 || !this.running || this.isPaused) break;

      const home = `home fatal diamante${i}`;
      await this.teleportVip(home);

      const chest = this.getTargetChestInFront();
      if (!chest) continue;

      try {
        const container = await this.bot.openContainer(chest);
        await this.sleep(1000);

        const diaItem = container.containerItems().find((it) => it.name === 'diamond_block');
        if (diaItem) {
          const needed = 64 - this.countDiamondBlocks();
          await container.withdraw(diaItem.type, null, Math.min(needed, diaItem.count));
          await this.sleep(500);
          this.emitLog(`💎 Blocos de diamante retirados de /${home}!`);
        }
        container.close();
        await this.sleep(600);
      } catch (err) {
        this.emitLog(`Erro ao abrir baú em /${home}: ${err.message}`);
      }
    }
  }

  async securePersonalSwordAndClearHotbar() {
    this.emitLog('🔒 Blindando espada própria no slot 9 e liberando hotbar...');

    const allSwords = this.bot.inventory.items().filter((i) => i.name === 'diamond_sword');
    allSwords.sort((a, b) => this.getSwordDurability(b) - this.getSwordDurability(a));

    if (allSwords.length > 0) {
      const bestSword = allSwords[0];
      if (bestSword.slot !== this.PERSONAL_SWORD_SLOT) {
        try {
          await this.bot.moveSlotItem(bestSword.slot, this.PERSONAL_SWORD_SLOT);
          await this.sleep(500);
        } catch (e) {}
      }
    }

    const items = this.bot.inventory.items();
    for (const item of items) {
      if (item.slot >= 36 && item.slot <= 44) {
        let emptySlot = null;
        for (let s = 10; s <= 35; s++) {
          if (!this.bot.inventory.slots[s]) {
            emptySlot = s;
            break;
          }
        }

        if (emptySlot !== null) {
          try {
            await this.bot.moveSlotItem(item.slot, emptySlot);
            await this.sleep(500);
          } catch (e) {}
        }
      }
    }
  }

  async restorePersonalSwordToHand() {
    const itemInSlot9 = this.bot.inventory.slots[this.PERSONAL_SWORD_SLOT];
    if (itemInSlot9 && itemInSlot9.name === 'diamond_sword') {
      try {
        await this.bot.equip(itemInSlot9, 'hand');
        await this.sleep(400);
        return true;
      } catch (e) {}
    }

    const anySword = this.getDiamondSword();
    if (anySword) {
      try {
        await this.bot.equip(anySword, 'hand');
        await this.sleep(400);
        return true;
      } catch (e) {}
    }

    return false;
  }

  async fetchEmergencySwordFromChest() {
    this.emitLog('🆘 [EMERGÊNCIA] VIP totalmente sem espada! Buscando reserva em /home fatal repararespadas1...');
    await this.teleportVip('home fatal repararespadas1');

    const chest = this.getTargetChestInFront();
    if (!chest) {
      this.emitLog('❌ Baú de emergência não encontrado.');
      return false;
    }

    try {
      const container = await this.bot.openContainer(chest);
      await this.sleep(1500);

      const swords = container.slots.slice(0, container.inventoryStart).filter((it) => {
        return it && it.name === 'diamond_sword' && this.getSwordDurability(it) >= 1000;
      });

      if (swords.length > 0) {
        this.emitLog(`🗡️ Retirando espada reserva do slot ${swords[0].slot}...`);
        await this.bot.clickWindow(swords[0].slot, 0, 1);
        await this.sleep(800);
        container.close();
        await this.sleep(600);
        await this.teleportVip('home mob');
        await this.restorePersonalSwordToHand();
        return true;
      } else {
        this.emitLog('⚠️ Baú de reparos também não possui espadas aptas no momento.');
        container.close();
        await this.sleep(600);
      }
    } catch (e) {
      this.emitLog(`Falha ao abrir baú de emergência: ${e.message}`);
    }

    return false;
  }

  async repairCurrentSword() {
    let sword = this.getDiamondSword();
    if (!sword) {
      return false;
    }

    await this.ensureDiamondBlocksSupply();

    this.emitLog(`🔨 Reparando espada própria no chão (Durabilidade: ${this.getSwordDurability(sword)}/1561)...`);
    try {
      await this.bot.equip(sword, 'hand');
      await this.sleep(500);
    } catch (e) {}

    await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
    await this.sleep(500);

    const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (blockBelow) {
      try {
        await this.bot.activateBlock(blockBelow);
      } catch (e) {
        this.bot.activateItem();
      }
    } else {
      this.bot.activateItem();
    }

    await this.sleep(1000);
    const updatedSword = this.getDiamondSword();
    const newDur = this.getSwordDurability(updatedSword);
    this.emitLog(`✅ Espada própria reparada com sucesso! Nova durabilidade: ${newDur}/1561.`);

    this.emitLog('📍 [VIP RETORNO] Retornando para /home mob após conserto da espada própria...');
    await this.teleportVip('home mob');
    await this.restorePersonalSwordToHand();
    return true;
  }

  async repairSwordsInChestHome(homeName) {
    await this.teleportVip(homeName);

    const chest = this.getTargetChestInFront();
    if (!chest) {
      this.emitLog(`❌ Baú não encontrado em /${homeName}.`);
      return;
    }

    let hasBrokenSwordsInChest = true;
    let cyclesWithoutProgress = 0;

    while (hasBrokenSwordsInChest && this.running && !this.isPaused && cyclesWithoutProgress < 3) {
      await this.securePersonalSwordAndClearHotbar();

      this.emitLog(`📦 Acessando baú em /${homeName}...`);
      let container = null;
      try {
        container = await this.bot.openContainer(chest);
        await this.sleep(1200);
      } catch (err) {
        this.emitLog(`Erro ao abrir baú: ${err.message}`);
        break;
      }

      const brokenInChest = container.slots.slice(0, container.inventoryStart).filter((it) => {
        return it && it.name === 'diamond_sword' && this.getSwordDurability(it) < 500;
      });

      if (brokenInChest.length === 0) {
        this.emitLog(`✅ Nenhuma espada com durabilidade < 500 restante em /${homeName}.`);
        hasBrokenSwordsInChest = false;
        container.close();
        await this.sleep(600);
        break;
      }

      const batchToWithdraw = brokenInChest.slice(0, 8);
      this.emitLog(`📥 Retirando lote de ${batchToWithdraw.length} espadas para reparo...`);

      let withdrawnCount = 0;
      for (const sw of batchToWithdraw) {
        try {
          await this.bot.clickWindow(sw.slot, 0, 1);
          await this.sleep(500);
          withdrawnCount++;
        } catch (wErr) {
          this.emitLog(`Falha ao retirar espada: ${wErr.message}`);
        }
      }

      container.close();
      await this.sleep(800);

      if (withdrawnCount === 0) {
        cyclesWithoutProgress++;
        continue;
      }

      this.emitLog('👀 Mirando no chão para reparar...');
      await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
      await this.sleep(1000);

      let currentSwordsToFix = this.bot.inventory.items().filter((it) => {
        return it.name === 'diamond_sword' && it.slot !== this.PERSONAL_SWORD_SLOT && this.getSwordDurability(it) < 500;
      });

      this.emitLog(`🔨 Reparando individualmente ${currentSwordsToFix.length} espadas...`);

      for (let i = 0; i < currentSwordsToFix.length; i++) {
        if (!this.running || this.isPaused) break;

        let brokenSword = this.bot.inventory.items().find((it) => {
          return it.name === 'diamond_sword' && it.slot !== this.PERSONAL_SWORD_SLOT && this.getSwordDurability(it) < 500;
        });

        if (!brokenSword) break;

        let repaired = false;
        let attempts = 0;

        while (!repaired && attempts < 3 && this.running && !this.isPaused) {
          attempts++;
          try {
            await this.bot.equip(brokenSword, 'hand');
            await this.sleep(500);
          } catch (e) {}

          const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
          if (blockBelow) {
            try {
              await this.bot.activateBlock(blockBelow);
            } catch (e) {
              this.bot.activateItem();
            }
          } else {
            this.bot.activateItem();
          }

          await this.sleep(1000);

          const held = this.bot.heldItem;
          const currentDur = this.getSwordDurability(held);

          if (currentDur >= 1400) {
            this.emitLog(`✨ Espada reparada! Durabilidade: ${currentDur}/1561`);
            repaired = true;
            this.sharedState.addRepairedSwords(1, this.config.username);
          } else {
            await this.sleep(1000);
          }
        }
      }

      this.emitLog('📦 Devolvendo espadas reparadas ao baú...');
      try {
        container = await this.bot.openContainer(chest);
        await this.sleep(1200);

        const repairedSwords = container.slots.slice(container.inventoryStart).filter((it) => {
          return it && it.name === 'diamond_sword' && it.slot !== this.PERSONAL_SWORD_SLOT && this.getSwordDurability(it) >= 1400;
        });

        for (const sw of repairedSwords) {
          try {
            await this.bot.clickWindow(sw.slot, 0, 1);
            await this.sleep(500);
          } catch (dErr) {}
        }

        container.close();
        await this.sleep(800);
      } catch (err) {
        this.emitLog(`Erro ao devolver espadas: ${err.message}`);
      }

      break;
    }
  }

  async repairFakeSwordsRoutine() {
    this.emitLog('⚡ Quantidade de espadas usadas >= 3! Limpando drops antes de ir aos baús...');

    // Venda prévia no mob antes de qualquer teleporte
    this.emitLog('📦 Executando /vender mobs antes de sair do mob...');
    this.bot.chat('/vender mobs');
    await this.sleep(1000);

    await this.checkAndSellDrops();
    await this.ensureDiamondBlocksSupply();

    const totalToFix = this.sharedState.getUsedSwords();

    await this.repairSwordsInChestHome('home fatal repararespadas1');

    if (totalToFix > 50) {
      this.emitLog('📦 Mais de 50 espadas registradas! Verificando /home fatal repararespadas2...');
      await this.repairSwordsInChestHome('home fatal repararespadas2');
    }

    this.sharedState.setUsedSwords(0, `${this.config.username} (VIP)`);
    this.emitLog('✨ Todas as espadas foram reparadas! Variável resetada para 0.');

    this.emitLog('📍 [VIP RETORNO] Teleportando de volta para /home mob...');
    await this.teleportVip('home mob');
    await this.restorePersonalSwordToHand();
    this.emitLog('⚔️ VIP pronto para retomar o combate!');
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
    await this.teleportVip('home mob');
    await this.restorePersonalSwordToHand();

    this.emitLog('🎯 VIP combatendo mobs continuamente...');

    while (this.running && !this.isPaused) {
      if (this.isHandlingAfk) {
        await this.sleep(1000);
        continue;
      }

      // 1. Reparo em lote das fakes
      if (this.sharedState.getUsedSwords() >= 3) {
        await this.repairFakeSwordsRoutine();
        continue;
      }

      // 2. Validação da espada na mão
      let currentSword = this.bot.heldItem;
      if (!currentSword || currentSword.name !== 'diamond_sword') {
        const restored = await this.restorePersonalSwordToHand();
        currentSword = this.bot.heldItem;

        if (!restored || !currentSword || currentSword.name !== 'diamond_sword') {
          const hasAnySword = this.getDiamondSword();
          if (hasAnySword) {
            await this.repairCurrentSword();
          } else {
            const retrieved = await this.fetchEmergencySwordFromChest();
            if (!retrieved) {
              this.emitLog('❌ VIP totalmente sem espadas no inventário e baús vazios. Aguardando 5s para checar novamente...');
              await this.sleep(5000);
            }
          }
          continue;
        }
      }

      let dur = this.getSwordDurability(currentSword);
      if (dur < this.MIN_DURABILITY_THRESHOLD) {
        this.emitLog(`🛡️ [BLINDAGEM] Durabilidade da espada atingiu ${dur}/1561 (< ${this.MIN_DURABILITY_THRESHOLD}). Reparando...`);
        await this.repairCurrentSword();
        continue;
      }

      // 3. Venda periódica
      if (Date.now() - this.lastInventoryCheck >= 4000) {
        await this.checkAndSellDrops();
        this.lastInventoryCheck = Date.now();
      }

      // 4. Ataque aos mobs com verificação pós-hit
      const mob = this.findNearbyMob();
      if (mob) {
        try {
          await this.bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true);
          this.bot.attack(mob);

          const afterHitSword = this.bot.heldItem;
          const afterHitDur = this.getSwordDurability(afterHitSword);

          if (!afterHitSword || afterHitSword.name !== 'diamond_sword' || afterHitDur < this.MIN_DURABILITY_THRESHOLD) {
            this.emitLog(`🛡️ [ALERTA PÓS-HIT] Durabilidade caiu para ${afterHitDur}/1561 logo após o ataque! Reparando...`);
            await this.repairCurrentSword();
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

module.exports = MobVipMacro;