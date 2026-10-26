const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');

class BiomeScoutMacro {
  constructor(bot, config, emitLog, sharedStateManager) {
    this.bot = bot;
    this.config = config;
    this.emitLog = emitLog;
    this.sharedState = sharedStateManager;

    this.running = false;
    this.isPaused = false;
    this.mcActive = false;
    this.mcWaitResolve = null;

    // Configuração de altitude e alvos
    this.CRUISE_Y = 150;
    this.STORAGE_FILE = path.join(__dirname, '..', 'storage.json');
    this.TARGET_BIOMES = [
      'taiga', 'cold_taiga', 'mega_taiga', 'taiga_hills', 'cold_taiga_hills', 'mega_taiga_hills',
      'jungle', 'jungle_edge', 'jungle_hills', 'jungle_mutated'
    ];

    // Anti-Spam de Chat
    this.lastCommandTime = 0;

    // Anti-Stuck
    this.lastPos = null;
    this.lastPosTime = Date.now();

    // Navegação em Chunks
    this.visitedChunks = new Set();
    this.florestaCount = 0;
    this.discoveredHomes = [];
    this.currentChunkTarget = null;

    this.loadStorage();
    this.setupListeners();
  }

  loadStorage() {
    try {
      if (fs.existsSync(this.STORAGE_FILE)) {
        const raw = fs.readFileSync(this.STORAGE_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.florestaCount = data.florestaCount || 0;
        this.visitedChunks = new Set(data.visitedChunks || []);
        this.discoveredHomes = data.discoveredHomes || [];
        this.emitLog(`💾 Storage carregado: florestaCount=${this.florestaCount}, ${this.visitedChunks.size} chunks exploradas.`);
      } else {
        this.saveStorage();
      }
    } catch (e) {
      this.emitLog(`⚠️ Erro ao carregar storage.json: ${e.message}`);
    }
  }

  saveStorage() {
    try {
      const data = {
        florestaCount: this.florestaCount,
        visitedChunks: Array.from(this.visitedChunks),
        discoveredHomes: this.discoveredHomes
      };
      fs.writeFileSync(this.STORAGE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      this.emitLog(`❌ Erro ao salvar storage.json: ${e.message}`);
    }
  }

  setupListeners() {
    this.messageListener = (msg) => {
      const raw = msg.toString();
      // Remove cores do Minecraft e acentos gráficos para matching 100% confiável
      const clean = raw
        .replace(/§[0-9a-fk-or]/gi, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

      // Identifica "Tapete Mágico invisível ativado!" e outras variações clássicas
      if (
        clean.includes('tapete magico') && clean.includes('ativado') ||
        clean.includes('magiccarpet ativado') ||
        clean.includes('carpet enabled') ||
        clean.includes('tapete ativado') ||
        clean.includes('voce ativou o tapete')
      ) {
        this.mcActive = true;
        this.emitLog('🪄 [MC] Confirmação do MagicCarpet detectada com sucesso!');
        if (this.mcWaitResolve) {
          this.mcWaitResolve(true);
          this.mcWaitResolve = null;
        }
      } else if (
        clean.includes('magiccarpet desativado') ||
        clean.includes('carpet disabled') ||
        clean.includes('tapete desativado')
      ) {
        this.mcActive = false;
        this.emitLog('🪄 [MC] MagicCarpet desativado.');
      }
    };
    this.bot.on('messagestr', this.messageListener);

    this.healthListener = () => {
      if (!this.running) return;
      if (this.bot.health < 16) {
        this.emitLog(`🚨 [PERIGO] Vida baixa (${this.bot.health}/20)! Acionando retorno para /home procurar...`);
        this.stopMovement();
        this.sendCommand('/home procurar', 3000);
      }
    };
    this.bot.on('health', this.healthListener);
  }

  async sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async sendCommand(cmd, minDelayAfter = 1800) {
    const elapsed = Date.now() - this.lastCommandTime;
    if (elapsed < 2000) {
      await this.sleep(2000 - elapsed);
    }
    this.bot.chat(cmd);
    this.lastCommandTime = Date.now();
    await this.sleep(minDelayAfter);
  }

  stopMovement() {
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);
  }

  // Ativação do /mc sem limite de tentativas, com delay de 5 segundos exatos entre cada envio
  async ensureMagicCarpet() {
    if (this.mcActive) return true;
    this.emitLog('🪄 Enviando /mc e aguardando confirmação (delay de 5s por tentativa)...');

    let attempt = 0;
    while (!this.mcActive && this.running) {
      attempt++;

      const waitPromise = new Promise((resolve) => {
        this.mcWaitResolve = resolve;
      });

      this.bot.chat('/mc');
      this.lastCommandTime = Date.now();

      // Timeout de 5 segundos cravados
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(false), 5000));
      const confirmed = await Promise.race([waitPromise, timeoutPromise]);

      if (confirmed || this.mcActive) {
        this.emitLog(`✅ MagicCarpet confirmado após tentativa #${attempt}. Pronto para voo.`);
        await this.sleep(1000);
        return true;
      }

      this.emitLog(`⏳ [MC] Tentativa #${attempt} sem confirmação após 5s. Reenviando /mc...`);
    }

    return this.mcActive;
  }

  // Ascensão suave real de Y até 150
  async ascendToCruise() {
    await this.ensureMagicCarpet();
    this.emitLog(`🚀 Iniciando ascensão estável no tapete até Y=${this.CRUISE_Y}...`);
    this.stopMovement();

    while (this.running && !this.isPaused && this.bot.entity.position.y < this.CRUISE_Y) {
      this.bot.entity.velocity.set(0, 0.28, 0);
      this.bot.setControlState('jump', true);

      const currentY = this.bot.entity.position.y;
      if (currentY + 0.35 <= this.CRUISE_Y) {
        this.bot.entity.position.y += 0.35;
      } else {
        this.bot.entity.position.y = this.CRUISE_Y;
      }

      await this.sleep(120);
      this.bot.setControlState('jump', false);
      await this.sleep(80);

      if (this.bot.entity.position.y >= this.CRUISE_Y) {
        break;
      }
    }

    this.stopMovement();
    this.bot.entity.velocity.set(0, 0, 0);
    this.emitLog(`✈️ Altitude de cruzeiro atingida: Y=${this.bot.entity.position.y.toFixed(1)}`);
  }

  getHighestSolidBlockBelow(x, z, startY) {
    for (let y = Math.floor(startY); y > 0; y--) {
      const b = this.bot.blockAt(new Vec3(x, y, z));
      if (b && b.boundingBox === 'block') {
        const unsafe = ['lava', 'flowing_lava', 'fire', 'cactus', 'water', 'flowing_water'];
        if (unsafe.includes(b.name)) {
          return null;
        }
        return b;
      }
    }
    return null;
  }

  async descendSafely() {
    this.emitLog('🛬 Iniciando descida estável no tapete até o solo seguro...');
    this.stopMovement();

    let pos = this.bot.entity.position;
    let safeBlock = this.getHighestSolidBlockBelow(pos.x, pos.z, pos.y);

    if (!safeBlock) {
      this.emitLog('⚠️ Terreno abaixo inseguro. Deslocando 4 blocos horizontalmente...');
      await this.bot.lookAt(new Vec3(pos.x + 4, pos.y, pos.z), true);
      this.bot.setControlState('forward', true);
      await this.sleep(1000);
      this.stopMovement();
      pos = this.bot.entity.position;
      safeBlock = this.getHighestSolidBlockBelow(pos.x, pos.z, pos.y);
    }

    const groundY = safeBlock ? safeBlock.position.y + 1 : 64;

    while (this.running && !this.isPaused && this.bot.entity.position.y > groundY + 0.6) {
      this.bot.entity.velocity.set(0, -0.28, 0);
      this.bot.setControlState('sneak', true);

      if (this.bot.entity.position.y - 0.4 >= groundY) {
        this.bot.entity.position.y -= 0.4;
      } else {
        this.bot.entity.position.y = groundY;
      }

      await this.sleep(120);
      this.bot.setControlState('sneak', false);
      await this.sleep(80);

      if (this.bot.entity.position.y <= groundY + 0.6) break;
    }

    this.stopMovement();
    this.bot.entity.velocity.set(0, 0, 0);
    await this.sleep(600);
    this.emitLog(`📍 Pouso concluído com sucesso em Y=${this.bot.entity.position.y.toFixed(1)}.`);
  }

  getCurrentChunkCoord() {
    return {
      cx: Math.floor(this.bot.entity.position.x / 16),
      cz: Math.floor(this.bot.entity.position.z / 16)
    };
  }

  getNextChunkTarget() {
    let { cx, cz } = this.getCurrentChunkCoord();

    const directions = [
      { dx: 1, dz: 0 },
      { dx: 0, dz: 1 },
      { dx: -1, dz: 0 },
      { dx: 0, dz: -1 }
    ];

    for (let r = 1; r < 250; r++) {
      for (let leg = 0; leg < 4; leg++) {
        for (let s = 0; s < r; s++) {
          cx += directions[leg].dx;
          cz += directions[leg].dz;
          const key = `${cx},${cz}`;
          if (!this.visitedChunks.has(key)) {
            return {
              cx,
              cz,
              targetX: cx * 16 + 8,
              targetZ: cz * 16 + 8
            };
          }
        }
      }
    }

    return { cx: cx + 1, cz: cz + 1, targetX: (cx + 1) * 16 + 8, targetZ: (cz + 1) * 16 + 8 };
  }

  async markDiscoveredBiome(biomeName) {
    this.emitLog(`🌲 Bioma Alvo Identificado: [${biomeName}]! Iniciando protocolo de marcação...`);
    this.stopMovement();

    await this.descendSafely();

    this.emitLog('📍 Atualizando /sethome procurar...');
    await this.sendCommand('/sethome procurar', 2000);
    await this.sendCommand('/sethome procurar', 2000);

    this.florestaCount++;
    const homeName = `floresta${this.florestaCount}`;
    this.emitLog(`📌 Marcando novo bioma: /sethome ${homeName}...`);
    await this.sendCommand(`/sethome ${homeName}`, 2000);
    await this.sendCommand(`/sethome ${homeName}`, 2000);

    const pos = this.bot.entity.position;
    this.discoveredHomes.push({
      name: homeName,
      biome: biomeName,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      z: Math.round(pos.z),
      time: new Date().toLocaleTimeString()
    });

    this.saveStorage();
    this.emitTelemetry();

    this.emitLog(`✨ Bioma ${homeName} gravado! Subindo de volta para Y=${this.CRUISE_Y}...`);
    await this.ascendToCruise();
  }

  emitTelemetry() {
    if (this.sharedState && typeof this.sharedState.updateMapTelemetry === 'function') {
      const pos = this.bot.entity.position;
      const currentBlock = this.bot.blockAt(pos);
      const biomeName = currentBlock && currentBlock.biome ? currentBlock.biome.name : 'desconhecido';

      this.sharedState.updateMapTelemetry({
        botName: this.config.username,
        pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
        currentBiome: biomeName,
        florestaCount: this.florestaCount,
        discoveredHomes: this.discoveredHomes,
        visitedChunksCount: this.visitedChunks.size
      });
    }
  }

  // --- Rotina de Reparo de Machados e Reabastecimento com Blocos de Diamante ---

  countDiamondBlocks() {
    let count = 0;
    for (const it of this.bot.inventory.items()) {
      if (it && it.name === 'diamond_block') count += it.count;
    }
    return count;
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
    this.emitLog('📦 Buscando blocos de diamante para reparo de machados...');

    for (let i = 1; i <= 10; i++) {
      if (this.countDiamondBlocks() >= 64 || !this.running || this.isPaused) break;

      const home = `home fatal diamante${i}`;
      this.emitLog(`📍 Teleportando para /${home}...`);
      await this.sendCommand(`/${home}`, 2000);

      const chest = this.getTargetChestInFront();
      if (!chest) continue;

      try {
        const container = await this.bot.openContainer(chest);
        await this.sleep(1200);

        let totalChestBlocks = 0;
        for (const it of container.containerItems()) {
          if (it && it.name === 'diamond_block') totalChestBlocks += it.count;
        }
        this.sharedState.updateDiamondStock(`diamante${i}`, totalChestBlocks / 64);

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

  getAxeDurability(axe) {
    if (!axe) return 0;
    const maxDur = axe.maxDurability || 1561;
    let damage = 0;
    if (typeof axe.metadata === 'number' && axe.metadata > 0) {
      damage = axe.metadata;
    } else if (axe.nbt && axe.nbt.value && axe.nbt.value.Damage) {
      damage = axe.nbt.value.Damage.value || 0;
    } else if (typeof axe.durabilityUsed === 'number') {
      damage = axe.durabilityUsed;
    }
    return Math.max(0, maxDur - damage);
  }

  async repairAxesInChestHome(homeName) {
    this.emitLog(`📍 Teleportando para baú de machados: /${homeName}...`);
    await this.sendCommand(`/${homeName}`, 2200);

    const chest = this.getTargetChestInFront();
    if (!chest) {
      this.emitLog(`❌ Baú de machados não encontrado em /${homeName}.`);
      return;
    }

    let cycles = 0;
    while (this.running && !this.isPaused && cycles < 3) {
      cycles++;
      let container = null;
      try {
        container = await this.bot.openContainer(chest);
        await this.sleep(1200);
      } catch (e) {
        break;
      }

      const brokenAxes = container.slots.slice(0, container.inventoryStart).filter((it) => {
        return it && it.name === 'diamond_axe' && this.getAxeDurability(it) < 500;
      });

      if (brokenAxes.length === 0) {
        this.emitLog(`✅ Todos os machados em /${homeName} estão reparados.`);
        container.close();
        await this.sleep(600);
        break;
      }

      const batch = brokenAxes.slice(0, 8);
      this.emitLog(`📥 Retirando lote de ${batch.length} machados para reparo...`);

      for (const ax of batch) {
        try {
          await this.bot.clickWindow(ax.slot, 0, 1);
          await this.sleep(400);
        } catch (err) {}
      }

      container.close();
      await this.sleep(800);

      await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
      await this.sleep(500);

      const axesToFix = this.bot.inventory.items().filter((it) => {
        return it.name === 'diamond_axe' && this.getAxeDurability(it) < 500;
      });

      for (const axe of axesToFix) {
        let repaired = false;
        let attempts = 0;
        while (!repaired && attempts < 3 && this.running && !this.isPaused) {
          attempts++;
          try {
            await this.bot.equip(axe, 'hand');
            await this.sleep(400);
          } catch (e) {}

          const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
          if (blockBelow) {
            try { await this.bot.activateBlock(blockBelow); } catch (e) { this.bot.activateItem(); }
          } else {
            this.bot.activateItem();
          }

          await this.sleep(800);
          const held = this.bot.heldItem;
          if (held && this.getAxeDurability(held) >= 1400) {
            repaired = true;
            this.sharedState.addRepairedSwords(1, `${this.config.username} (Machado)`);
          }
        }
      }

      try {
        container = await this.bot.openContainer(chest);
        await this.sleep(1200);

        const repairedAxes = container.slots.slice(container.inventoryStart).filter((it) => {
          return it && it.name === 'diamond_axe' && this.getAxeDurability(it) >= 1400;
        });

        for (const ax of repairedAxes) {
          try {
            await this.bot.clickWindow(ax.slot, 0, 1);
            await this.sleep(400);
          } catch (e) {}
        }

        container.close();
        await this.sleep(800);
      } catch (e) {}
      break;
    }
  }

  async handleAxeRepairRoutine() {
    this.emitLog('⚡ Limite de machados quebrados atingido na fila global! Salvando ponto e indo reparar...');

    await this.descendSafely();
    this.emitLog('📌 Marcando ponto atual em /sethome procurar...');
    await this.sendCommand('/sethome procurar', 2000);
    await this.sendCommand('/sethome procurar', 2000);

    await this.ensureDiamondBlocksSupply();

    await this.repairAxesInChestHome('home fatal repararmachados1');
    if (this.sharedState.getUsedSwords() > 50) {
      await this.repairAxesInChestHome('home fatal repararmachados2');
    }

    this.sharedState.setUsedSwords(0, `${this.config.username} (Scout/Machados)`);
    this.emitLog('✨ Fila de machados zerada com sucesso!');

    this.emitLog('📍 Retornando para /home procurar para continuar a exploração...');
    await this.sendCommand('/home procurar', 3000);
    await this.ascendToCruise();
  }

  // --- Ciclo Principal ---

  async start() {
    this.running = true;
    this.isPaused = false;
    this.emitLog('🛰️ Macro Biome Scout iniciada! Estabelecendo ponto inicial em /home procurar...');

    await this.sendCommand('/home procurar', 3000);
    await this.ascendToCruise();

    while (this.running) {
      if (this.isPaused) {
        await this.sleep(1000);
        continue;
      }

      try {
        await this.mainLoop();
      } catch (err) {
        this.emitLog(`⚠️ Erro no ciclo de biomas: ${err.message}. Reiniciando em 3s...`);
        this.stopMovement();
        await this.sleep(3000);
      }
    }
  }

  pause() {
    this.isPaused = true;
    this.stopMovement();
    this.emitLog('⏸️ Macro Biome Scout pausada.');
  }

  resume() {
    this.isPaused = false;
    this.emitLog('▶️ Macro Biome Scout retomada.');
  }

  stop() {
    this.running = false;
    this.isPaused = false;
    this.stopMovement();
    this.bot.removeListener('messagestr', this.messageListener);
    this.bot.removeListener('health', this.healthListener);
    this.emitLog('⏹️ Macro Biome Scout finalizada.');
  }

  async mainLoop() {
    if (this.sharedState.getUsedSwords() >= 3) {
      await this.handleAxeRepairRoutine();
      return;
    }

    if (Math.abs(this.bot.entity.position.y - this.CRUISE_Y) > 2) {
      await this.ascendToCruise();
    }

    const { cx, cz } = this.getCurrentChunkCoord();
    const chunkKey = `${cx},${cz}`;
    if (!this.visitedChunks.has(chunkKey)) {
      this.visitedChunks.add(chunkKey);
      this.saveStorage();
      this.emitTelemetry();
    }

    const currentBlock = this.bot.blockAt(this.bot.entity.position);
    if (currentBlock && currentBlock.biome) {
      const biomeName = currentBlock.biome.name.toLowerCase();
      if (this.TARGET_BIOMES.some((tb) => biomeName.includes(tb))) {
        await this.markDiscoveredBiome(biomeName);
        return;
      }
    }

    if (!this.currentChunkTarget || (cx === this.currentChunkTarget.cx && cz === this.currentChunkTarget.cz)) {
      this.currentChunkTarget = this.getNextChunkTarget();
      this.emitLog(`🧭 Rumo à Chunk [${this.currentChunkTarget.cx}, ${this.currentChunkTarget.cz}]...`);
    }

    const targetVec = new Vec3(this.currentChunkTarget.targetX, this.CRUISE_Y, this.currentChunkTarget.targetZ);
    await this.bot.lookAt(targetVec, true);
    this.bot.setControlState('forward', true);

    const currentPos = this.bot.entity.position;
    if (this.lastPos) {
      const dist = Math.hypot(currentPos.x - this.lastPos.x, currentPos.z - this.lastPos.z);
      if (dist < 1.0) {
        if (Date.now() - this.lastPosTime > 8000) {
          this.emitLog('⚠️ [ANTI-STUCK] Preso no ar por 8s! Forçando manobra evasiva 90°...');
          this.bot.setControlState('forward', false);
          this.bot.setControlState('right', true);
          this.bot.setControlState('jump', true);
          await this.sleep(1200);
          this.bot.setControlState('right', false);
          this.bot.setControlState('jump', false);
          this.lastPosTime = Date.now();
        }
      } else {
        this.lastPos = currentPos.clone();
        this.lastPosTime = Date.now();
      }
    } else {
      this.lastPos = currentPos.clone();
      this.lastPosTime = Date.now();
    }

    await this.sleep(250);
  }
}

module.exports = BiomeScoutMacro;