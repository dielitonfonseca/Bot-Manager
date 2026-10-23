const Vec3 = require('vec3');

class LumberjackMacro {
  constructor(bot, config, emitLog) {
    this.bot = bot;
    this.config = config;
    this.emitLog = emitLog;
    this.running = false;
    this.isPaused = false;

    this.mcActive = false;
    this.lastCommandTime = 0;
    this.blocksMinedCounter = 0;

    // Listener de confirmação do Magic Carpet
    this.chatListener = (message) => {
      const raw = message.toString();
      const clean = raw
        .replace(/§[0-9a-fk-or]/gi, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

      const isActivation =
        (clean.includes('tapete') && clean.includes('ativado')) ||
        (clean.includes('magiccarpet') && clean.includes('enabled')) ||
        clean.includes('invisivel ativado');

      const isDeactivation =
        (clean.includes('tapete') && clean.includes('desativado')) ||
        (clean.includes('magiccarpet') && clean.includes('disabled')) ||
        clean.includes('invisivel desativado');

      if (isActivation && !isDeactivation) {
        this.mcActive = true;
        this.emitLog('🟢 [MC] Confirmado pelo chat: ATIVADO!');
      } else if (isDeactivation) {
        this.mcActive = false;
        this.emitLog('🔴 [MC] Confirmado pelo chat: DESATIVADO!');
      }
    };
    this.bot.on('messagestr', this.chatListener);
  }

  async start() {
    this.running = true;
    this.isPaused = false;
    this.emitLog('🌲 Iniciando Macro de Lenhador com sistema anti-enclausuramento de relevo...');

    while (this.running) {
      if (this.isPaused) {
        await this.sleep(1000);
        continue;
      }

      try {
        await this.mainExecutionLoop();
      } catch (err) {
        this.emitLog(`⚠️ Erro no loop da macro: ${err.message}. Reiniciando em 3s...`);
        this.stopMovement();
        await this.sleep(3000);
      }
    }
  }

  pause() {
    this.isPaused = true;
    this.stopMovement();
    this.emitLog('⏸️ Macro Lenhador pausada.');
  }

  resume() {
    this.isPaused = false;
    this.emitLog('▶️ Macro Lenhador retomada.');
  }

  stop() {
    this.running = false;
    this.isPaused = false;
    this.stopMovement();
    this.bot.removeListener('messagestr', this.chatListener);
    this.emitLog('⏹️ Macro Lenhador finalizada.');
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stopMovement() {
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);
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

  isPhysicallySupportedByMc() {
    if (!this.bot.entity) return false;
    const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (!blockBelow) return false;

    const name = blockBelow.name.toLowerCase();
    return (
      name.includes('glass') ||
      name.includes('barrier') ||
      (this.bot.entity.velocity && Math.abs(this.bot.entity.velocity.y) < 0.05 && this.bot.entity.onGround)
    );
  }

  async ensureMagicCarpetActive() {
    let attempts = 0;

    while (!this.mcActive && this.running && !this.isPaused) {
      attempts++;
      this.emitLog(`🛰️ [Tentativa #${attempts}] Solicitando ativação do /mc...`);
      await this.sendCommand('/mc', 1500);

      let waited = 0;
      while (!this.mcActive && waited < 3500) {
        await this.sleep(500);
        waited += 500;

        if (this.isPhysicallySupportedByMc()) {
          this.mcActive = true;
          this.emitLog('🟢 [MC] Confirmado via física do ambiente.');
          break;
        }
      }

      if (this.mcActive) {
        this.emitLog('✅ /mc confirmado com sucesso.');
        break;
      }

      this.emitLog('⏳ /mc ainda não reconhecido. Aguardando 11s contra anti-spam...');
      await this.sleep(11000);
    }
  }

  async ensureDiamondBlocks() {
    const hasDiamond = this.bot.inventory.items().some(i => i.name === 'diamond_block' && i.count > 0);
    if (hasDiamond) return;

    this.emitLog('📦 Sem blocos de diamante. Indo para /home fatal foxrecursos...');
    await this.sendCommand('/home fatal foxrecursos', 3500);

    const chestBlock = this.bot.findBlock({
      matching: ['chest', 'trapped_chest'].map(n => this.bot.registry.blocksByName[n]?.id).filter(Boolean),
      maxDistance: 6
    });

    if (!chestBlock) {
      this.emitLog('❌ Nenhum baú encontrado em /home fatal foxrecursos!');
      return;
    }

    try {
      const chest = await this.bot.openContainer(chestBlock);
      await this.sleep(1000);
      const diamondItem = chest.containerItems().find(i => i.name === 'diamond_block');

      if (diamondItem) {
        await chest.withdraw(diamondItem.type, null, 64);
        this.emitLog('✅ 1 Pack de blocos de diamante retirado do baú.');
        await this.sleep(1000);
      } else {
        this.emitLog('⚠️ Aviso: Nenhum bloco de diamante encontrado no baú!');
      }
      chest.close();
    } catch (err) {
      this.emitLog(`Erro ao abrir baú: ${err.message}`);
    }
  }

  getAxe() {
    const axes = this.bot.inventory.items().filter(item => item.name.includes('_axe'));
    return axes.length > 0 ? axes[0] : null;
  }

  getAxeDurability(axe) {
    if (!axe) return 0;
    const maxDur = axe.maxDurability || 1561;
    return maxDur - (axe.durabilityUsed || 0);
  }

  async ensureAxeRepaired() {
    let axe = this.getAxe();
    if (!axe) {
      this.emitLog('⚠️ Nenhum machado encontrado no inventário!');
      return;
    }

    let dur = this.getAxeDurability(axe);
    if (dur >= 100) return;

    this.emitLog(`⚠️ Durabilidade baixa (${dur} < 100). Iniciando rotina de reparo...`);

    this.emitLog('📍 Salvando /sethome lenha...');
    await this.sendCommand('/sethome lenha', 1000);
    await this.sendCommand('/sethome lenha', 1000);

    let repaired = false;
    let attempts = 0;

    while (!repaired && attempts < 4 && this.running && !this.isPaused) {
      attempts++;
      this.emitLog(`[Reparo #${attempts}] Teleportando para /home fatal homesafe...`);
      await this.sendCommand('/home fatal homesafe', 1000);

      axe = this.getAxe();
      if (axe) {
        try { await this.bot.equip(axe, 'hand'); } catch (e) {}
      }

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

      this.emitLog('🔨 Clique efetuado. Aguardando 1s...');
      await this.sleep(1000);

      const checkAxe = this.getAxe();
      const newDur = this.getAxeDurability(checkAxe);
      if (newDur > dur && newDur >= 100) {
        this.emitLog(`✅ Machado reparado com sucesso! Durabilidade: ${newDur}`);
        repaired = true;
      } else {
        this.emitLog(`❌ Durabilidade não aumentou (${newDur}). Tentando novamente...`);
        await this.sleep(1500);
      }
    }
  }

  async checkInventoryAndSell() {
    const logItems = this.bot.inventory.items().filter(item =>
      item.name.includes('_log') || item.name === 'log' || item.name === 'log2' || item.name.includes('wood')
    );

    let total = 0;
    for (const item of logItems) total += item.count;

    if (total / 64 >= 18) {
      this.emitLog(`💰 Inventário com ${total} madeiras (18 packs). Executando /vender farms...`);
      this.stopMovement();
      await this.sendCommand('/vender farms', 3500);
      this.blocksMinedCounter = 0;
    }
  }

  isHazardAhead(aheadVec) {
    const blockAtTarget = this.bot.blockAt(aheadVec);
    const blockBelow = this.bot.blockAt(aheadVec.offset(0, -1, 0));
    const blockDeep = this.bot.blockAt(aheadVec.offset(0, -3, 0));

    if (blockAtTarget?.name.includes('lava') || blockBelow?.name.includes('lava')) return 'LAVA';
    if (blockAtTarget?.name.includes('water') || blockBelow?.name.includes('water')) return 'AGUA';
    if (blockAtTarget?.name === 'air' && blockBelow?.name === 'air' && blockDeep?.name === 'air') return 'RAVINA';

    return null;
  }

  // Detecta se o bot está cercado por terra/relevo em forma de buraco/vala
  isTrappedInHole() {
    if (!this.bot.entity) return false;
    const pos = this.bot.entity.position;

    // Checa blocos nos 4 pontos cardeais em Y+1
    const checks = [
      pos.offset(1, 1, 0),
      pos.offset(-1, 1, 0),
      pos.offset(0, 1, 1),
      pos.offset(0, 1, -1)
    ];

    let solidBlocksAround = 0;
    for (const p of checks) {
      const b = this.bot.blockAt(p);
      if (b && b.name !== 'air' && !b.name.includes('leaves')) {
        solidBlocksAround++;
      }
    }

    // Se 2 ou mais lados tiverem parede de bloco na altura do peito, é buraco/depressão
    return solidBlocksAround >= 2;
  }

  // Eleva o bot no /MC até sair completamente da vala/buraco com validação de coordenadas
  async elevateOutOfHole() {
    this.emitLog('🧗 [Anti-Buraco] Cercamento detectado! Elevando verticalmente no /MC...');
    const startY = this.bot.entity.position.y;

    // Garante que o MC está ativo
    if (!this.mcActive) {
      await this.ensureMagicCarpetActive();
    }

    // Segura pulo para subir múltiplos blocos de altura
    for (let i = 0; i < 3; i++) {
      this.bot.setControlState('jump', true);
      await this.sleep(600);
      this.bot.setControlState('jump', false);
      await this.sleep(300);

      const currentY = this.bot.entity.position.y;
      if (currentY - startY >= 2.0 && !this.isTrappedInHole()) {
        this.emitLog(`✅ Saiu do buraco com sucesso! (Subiu ${(currentY - startY).toFixed(1)} blocos de altura)`);
        
        // Dá um impulso à frente no ar para sair do perímetro do buraco
        this.bot.setControlState('forward', true);
        await this.sleep(400);
        this.stopMovement();
        return true;
      }
    }

    // Se mesmo no /MC não subiu, há teto ou quina rígida: escava rampa de saída
    this.emitLog('⛏️ Subida pura bloqueada. Escavando degraus de terra para sair...');
    await this.carveRampOutOfHole();
    return false;
  }

  // Escava degraus de terra/grama na frente para criar uma rampa acessível a pé
  async carveRampOutOfHole() {
    const yaw = this.bot.entity.yaw;
    const forwardVec = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
    const pos = this.bot.entity.position;

    // Quebra bloco dos olhos e pés para desbastar a parede de 2 blocos de terra
    for (let dy of [2, 1, 0]) {
      const targetPos = pos.plus(forwardVec.scaled(1.1)).offset(0, dy, 0).floored();
      const b = this.bot.blockAt(targetPos);
      if (b && b.name !== 'air') {
        try {
          const axe = this.getAxe();
          if (axe) await this.bot.equip(axe, 'hand');
          await this.bot.dig(b);
          await this.sleep(200);
        } catch (e) {}
      }
    }

    // Tenta saltar para frente sobre a rampa aberta
    this.bot.setControlState('jump', true);
    this.bot.setControlState('forward', true);
    await this.sleep(400);
    this.bot.setControlState('jump', false);
    await this.sleep(200);
    this.stopMovement();
  }

  findBestClearDirection(preferentialAngle = null) {
    const pos = this.bot.entity.position;
    const angles = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, -(3 * Math.PI) / 4, -Math.PI / 2, -Math.PI / 4];

    if (preferentialAngle !== null) {
      angles.sort((a, b) => Math.abs(a - preferentialAngle) - Math.abs(b - preferentialAngle));
    }

    for (const angle of angles) {
      const dirVec = new Vec3(-Math.sin(angle), 0, -Math.cos(angle)).normalize();

      const p1Feet = pos.plus(dirVec.scaled(1.2)).offset(0, 0, 0).floored();
      const p1Head = pos.plus(dirVec.scaled(1.2)).offset(0, 1, 0).floored();

      const b1F = this.bot.blockAt(p1Feet);
      const b1H = this.bot.blockAt(p1Head);

      const clearP1 = (!b1F || b1F.name === 'air') && (!b1H || b1H.name === 'air');

      if (clearP1) {
        return angle;
      }
    }
    return null;
  }

  async moveStepTowards(targetYaw) {
    // 1. Checa se já está em um buraco antes de tentar andar
    if (this.isTrappedInHole()) {
      await this.elevateOutOfHole();
    }

    await this.bot.look(targetYaw, 0, true);

    const posBefore = this.bot.entity.position.clone();
    const forwardVec = new Vec3(-Math.sin(targetYaw), 0, -Math.cos(targetYaw)).normalize();
    const checkPoint = posBefore.plus(forwardVec.scaled(1.5));

    const hazard = this.isHazardAhead(checkPoint);
    if (hazard) {
      this.emitLog(`⚠️ Perigo detectado (${hazard}). Elevando altitude no /MC...`);
      this.bot.setControlState('jump', true);
      await this.sleep(1200);
      this.bot.setControlState('jump', false);
    }

    this.bot.setControlState('forward', true);
    this.bot.setControlState('sprint', true);
    await this.sleep(550);

    const posAfter = this.bot.entity.position.clone();
    const distMoved = Math.hypot(posAfter.x - posBefore.x, posAfter.z - posBefore.z);

    // BATEU OU TRAVOU EM RELEVO
    if (distMoved < 0.35) {
      this.stopMovement();
      this.emitLog(`🛑 Colisão em relevo (moveu apenas ${distMoved.toFixed(2)}b).`);

      // Recua para soltar a quina
      this.bot.setControlState('back', true);
      await this.sleep(180);
      this.bot.setControlState('back', false);

      // Se caiu em buraco ou vala, sobe pelo /MC
      if (this.isTrappedInHole() || this.bot.entity.isCollidedHorizontally) {
        await this.elevateOutOfHole();
        return;
      }

      // Procura direção desimpedida
      const clearAngle = this.findBestClearDirection(targetYaw + Math.PI / 2);
      if (clearAngle !== null) {
        this.emitLog('↪️ Mudando de rumo para espaço aberto livre de blocos...');
        await this.bot.look(clearAngle, 0, true);
        this.bot.setControlState('forward', true);
        await this.sleep(500);
        this.stopMovement();
        return;
      }

      // Salto com /MC para superar degrau simples
      this.bot.setControlState('jump', true);
      this.bot.setControlState('forward', true);
      await this.sleep(400);
      this.bot.setControlState('jump', false);
      await this.sleep(250);
      this.stopMovement();
    }

    this.stopMovement();
  }

  findNearestTreeBlock(maxDistance = 45) {
    const logIds = Object.keys(this.bot.registry.blocksByName)
      .filter(n => n.includes('log') || n.includes('wood'))
      .map(n => this.bot.registry.blocksByName[n].id);

    return this.bot.findBlock({
      matching: logIds,
      maxDistance: maxDistance
    });
  }

  async tryBreakHighTrunkDirectlyAbove(highLogBlock) {
    this.emitLog(`📍 Posicionando abaixo do tronco alto em ${highLogBlock.position}...`);

    for (let i = 0; i < 8; i++) {
      if (!this.running || this.isPaused) return false;
      const currentPos = this.bot.entity.position;
      const horizontalDist = Math.hypot(highLogBlock.position.x + 0.5 - currentPos.x, highLogBlock.position.z + 0.5 - currentPos.z);

      if (horizontalDist < 0.6) {
        this.stopMovement();
        break;
      }

      const dx = highLogBlock.position.x + 0.5 - currentPos.x;
      const dz = highLogBlock.position.z + 0.5 - currentPos.z;
      const yaw = Math.atan2(-dx, -dz);

      await this.bot.look(yaw, 0, true);
      this.bot.setControlState('forward', true);
      await this.sleep(200);
      this.stopMovement();
    }

    this.emitLog('👀 Mirando reto para cima para quebrar tronco...');
    await this.bot.look(this.bot.entity.yaw, Math.PI / 2, true);
    await this.sleep(300);

    const axe = this.getAxe();
    if (axe) {
      try { await this.bot.equip(axe, 'hand'); } catch (e) {}
    }

    const distanceToBlock = this.bot.entity.position.distanceTo(highLogBlock.position);
    if (distanceToBlock <= 5.2 && this.bot.canDigBlock(highLogBlock)) {
      try {
        await this.bot.dig(highLogBlock);
        this.blocksMinedCounter++;
        this.emitLog('✅ Tronco alto quebrado olhando diretamente para cima!');
        await this.sleep(250);
        return true;
      } catch (err) {
        this.emitLog(`Falha ao quebrar acima: ${err.message}`);
      }
    } else {
      this.emitLog(`⚠️ Tronco fora de alcance (${distanceToBlock.toFixed(1)}b). Indo para próxima árvore.`);
    }

    return false;
  }

  async chopEntireTree(baseLogBlock) {
    this.emitLog(`🪓 Alvo: tronco em ${baseLogBlock.position}. Deslocando...`);

    let reached = false;
    for (let i = 0; i < 15; i++) {
      if (!this.running || this.isPaused) return;
      const currentPos = this.bot.entity.position;
      const dist = currentPos.distanceTo(baseLogBlock.position);

      if (dist <= 3.2) {
        reached = true;
        break;
      }

      const dx = baseLogBlock.position.x - currentPos.x;
      const dz = baseLogBlock.position.z - currentPos.z;
      const yaw = Math.atan2(-dx, -dz);
      await this.moveStepTowards(yaw);
    }

    if (!reached) {
      this.emitLog('⚠️ Não conseguiu aproximar do tronco. Pulando para a próxima árvore...');
      return;
    }

    const logIds = Object.keys(this.bot.registry.blocksByName)
      .filter(n => n.includes('log') || n.includes('wood'))
      .map(n => this.bot.registry.blocksByName[n].id);

    let treeFinished = false;

    while (!treeFinished && this.running && !this.isPaused) {
      const axe = this.getAxe();
      if (axe) {
        try { await this.bot.equip(axe, 'hand'); } catch (e) {}
      }

      const nearbyLog = this.bot.findBlock({
        matching: logIds,
        maxDistance: 4.2
      });

      if (nearbyLog) {
        try {
          await this.bot.dig(nearbyLog);
          this.blocksMinedCounter++;
          await this.sleep(200);

          if (this.blocksMinedCounter % 10 === 0) {
            await this.checkInventoryAndSell();
          }

          const currentAxe = this.getAxe();
          if (this.getAxeDurability(currentAxe) < 100) {
            this.emitLog('⚠️ Durabilidade menor que 100. Acionando reparo...');
            return;
          }
        } catch (err) {
          this.emitLog(`Falha ao quebrar: ${err.message}`);
          break;
        }
      } else {
        const highLog = this.bot.findBlock({
          matching: logIds,
          maxDistance: 6.0
        });

        if (highLog && highLog.position.y > this.bot.entity.position.y) {
          const brokeHigh = await this.tryBreakHighTrunkDirectlyAbove(highLog);
          if (!brokeHigh) {
            treeFinished = true;
          }
        } else {
          treeFinished = true;
        }
      }
    }

    this.emitLog('✅ Árvore finalizada! Buscando próxima madeira...');
  }

  async mainExecutionLoop() {
    this.emitLog('📍 [Passo 1] Teleportando para /home lenha...');
    await this.sendCommand('/home lenha', 3500);

    this.emitLog('🛰️ [Passo 2] Conferindo estado do /mc...');
    await this.ensureMagicCarpetActive();

    this.emitLog('💎 [Passo 3] Verificando blocos de diamante...');
    await this.ensureDiamondBlocks();

    this.emitLog('🔨 [Passo 4] Verificando durabilidade do machado...');
    await this.ensureAxeRepaired();

    this.emitLog('📍 [Passo 5] Retornando para /home lenha...');
    await this.sendCommand('/home lenha', 3500);

    this.emitLog('🛰️ [Passo 6] Reconfirmando /mc ativo...');
    await this.ensureMagicCarpetActive();

    let searchAngle = Math.random() * Math.PI * 2;
    this.emitLog('🧭 [Passo 7] Escolhendo direção e iniciando busca por árvores...');

    while (this.running && !this.isPaused) {
      const axe = this.getAxe();
      if (this.getAxeDurability(axe) < 100) {
        this.emitLog('⚠️ Durabilidade atingiu limite durante a busca. Retornando ao reparo...');
        break;
      }

      const tree = this.findNearestTreeBlock(45);

      if (tree) {
        await this.chopEntireTree(tree);
      } else {
        this.emitLog('🔍 Nenhuma árvore no campo visível. Marchando e sobrevoando relevo...');
        for (let step = 0; step < 12; step++) {
          if (!this.running || this.isPaused) break;
          await this.moveStepTowards(searchAngle);

          if (this.findNearestTreeBlock(30)) break;
        }

        if (!this.findNearestTreeBlock(35)) {
          const nextClear = this.findBestClearDirection(searchAngle + Math.PI / 2);
          searchAngle = nextClear !== null ? nextClear : (searchAngle + Math.PI / 2) % (Math.PI * 2);
          this.emitLog('🔄 Mudando rumo para exploração de nova área aberta...');
        }
      }
    }
  }
}

module.exports = LumberjackMacro;