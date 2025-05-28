const express = require("express");
const multer = require("multer");
const unzipper = require("unzipper");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Client, GatewayIntentBits, REST, Routes, Collection, Events, EmbedBuilder } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { HttpsProxyAgent } = require('https-proxy-agent');
const dns = require('dns');
const { REST: DiscordRest } = require('@discordjs/rest');

// Force IPv4 for all DNS lookups
dns.setDefaultResultOrder('ipv4first');

// Configurações
const TOKEN = process.env.DISCORD_TOKEN || 'MTM3MzMwMzEyMTQwODY4ODE4OA.GfUge0.IgJfhqZVC4q60Q-ykKaVjGfFsemiQXJHtHdT-M';
const CLIENT_ID = process.env.CLIENT_ID || '1373303121408688188';
const PORT = process.env.PORT || 3000;

// Configure REST client
const rest = new DiscordRest({ version: '10' }).setToken(TOKEN);

// Inicialização do cliente Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  rest: {
    version: '10',
    api: 'https://discord.com/api'
  }
});

// Correção para o erro de cachce
if (client.users && !client.users.cache) {
  // Definir cache se não existir
  client.users.cache = new Collection();
}

// PATCH: Correção para prevenir erro de digitação "cachce"
Object.defineProperty(client.users, 'cachce', {
  get() {
    console.error('AVISO: Erro de digitação detectado - "cachce" em vez de "cache"');
    console.trace('Rastreamento de pilha:');
    return client.users.cache;
  }
});

// Express
const app = express();

// Configurações do Express
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuração do Multer para upload de arquivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => {
    const botName = req.body.botName ? 
      `${req.body.botName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}` : 
      `bot_${Date.now()}`;
    cb(null, `${botName}.zip`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // Limite de 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || 
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos ZIP são permitidos'));
    }
  }
});

// Criar diretórios necessários se não existirem
const requiredDirs = ['uploads', 'bots', 'logs', 'discord_uploads'];
requiredDirs.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Armazenamento de dados dos bots (em produção, usar banco de dados)
const botRegistry = {
  bots: {},
  
  // Retorna lista de bots formatada para exibição
  getList() {
    return Object.keys(this.bots).map(id => ({
      id,
      ...this.bots[id]
    }));
  },
  
  // Retorna apenas os bots de um usuário específico
  getUserBots(userId) {
    return Object.keys(this.bots)
      .filter(id => this.bots[id].discordId && this.bots[id].discordId.userId === userId)
      .map(id => ({
        id,
        ...this.bots[id]
      }));
  },
  
  // Registra um novo bot
  register(id, name, extractPath, discordId = null) {
    this.bots[id] = {
      id,
      name: name || `Bot ${id}`,
      path: extractPath,
      status: 'stopped',
      process: null,
      createdAt: new Date(),
      logFile: path.join('logs', `bot_${id}.log`),
      discordId
    };
    return this.bots[id];
  },
  
  // Atualiza o status de um bot
  updateStatus(id, status) {
    if (this.bots[id]) {
      this.bots[id].status = status;
      return true;
    }
    return false;
  },
  
  // Remove um bot do registro
  remove(id) {
    if (this.bots[id]) {
      delete this.bots[id];
      return true;
    }
    return false;
  }
};

// Armazenamento de canais privados
const privateChannels = new Map();

// Função para iniciar um bot
function startBot(botId) {
  const bot = botRegistry.bots[botId];
  if (!bot || bot.status === 'running') return false;
  
  const indexPath = path.join(bot.path, "index.js");
  
  if (!fs.existsSync(indexPath)) {
    return false;
  }
  
  // Criar arquivo de log
  const logStream = fs.createWriteStream(bot.logFile, { flags: 'a' });
  logStream.write(`\n[${new Date().toISOString()}] Iniciando bot ${bot.name}\n`);
  
  // Rodar o bot
  const botProcess = spawn("node", [indexPath], {
    cwd: bot.path,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  botProcess.stdout.pipe(logStream);
  botProcess.stderr.pipe(logStream);
  
  botProcess.on("exit", code => {
    logStream.write(`[${new Date().toISOString()}] Bot finalizado com código ${code}\n`);
    logStream.end();
    botRegistry.updateStatus(botId, 'stopped');
    
    // Notificar no Discord se o bot foi iniciado a partir do Discord
    if (bot.discordId && client.isReady()) {
      const channel = client.channels.cache.get(bot.discordId.channelId);
      if (channel) {
        channel.send(`⚠️ O bot **${bot.name}** foi finalizado com código ${code}`);
      }
    }
  });
  
  bot.process = botProcess;
  botRegistry.updateStatus(botId, 'running');
  return true;
}

// Função para parar um bot
function stopBot(botId) {
  const bot = botRegistry.bots[botId];
  if (!bot || bot.status !== 'running' || !bot.process) return false;
  
  bot.process.kill();
  bot.process = null;
  botRegistry.updateStatus(botId, 'stopped');
  return true;
}

// Função para processar arquivos ZIP e instalar dependências
async function processZipFile(zipPath, botId, botName, discordId = null) {
  try {
    const extractPath = path.join(__dirname, "bots", `bot_${botId}`);
    fs.mkdirSync(extractPath, { recursive: true });
    
    // Extrair o ZIP
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: extractPath }))
        .on("close", resolve)
        .on("error", reject);
    });
    
    const indexPath = path.join(extractPath, "index.js");
    
    if (!fs.existsSync(indexPath)) {
      throw new Error('Arquivo index.js não encontrado no ZIP');
    }
    
    // Registrar o bot
    const bot = botRegistry.register(botId, botName, extractPath, discordId);
    
    // Instalar dependências
    const logMessage = `[${new Date().toISOString()}] Instalando dependências para ${bot.name}\n`;
    fs.writeFileSync(bot.logFile, logMessage);
    
    // Notificar no Discord se for instalação pelo Discord
    if (discordId && client.isReady()) {
      const channel = client.channels.cache.get(discordId.channelId);
      if (channel) {
        await channel.send(`🔄 Instalando dependências para **${bot.name}**...`);
      }
    }
    
    return new Promise((resolve, reject) => {
      const npmInstall = spawn("npm", ["install"], {
        cwd: extractPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      const logStream = fs.createWriteStream(bot.logFile, { flags: 'a' });
      npmInstall.stdout.pipe(logStream);
      npmInstall.stderr.pipe(logStream);
      
      npmInstall.on("close", code => {
        logStream.write(`[${new Date().toISOString()}] Instalação concluída com código ${code}\n`);
        
        if (code !== 0) {
          logStream.end();
          botRegistry.updateStatus(botId, 'error');
          reject(new Error('Falha ao instalar dependências'));
          return;
        }
        
        // Iniciar o bot
        const started = startBot(botId);
        
        if (!started) {
          reject(new Error('Falha ao iniciar o bot'));
          return;
        }
        
        resolve(bot);
      });
    });
  } catch (error) {
    console.error('Erro ao processar arquivo ZIP:', error);
    throw error;
  }
}

// ===== CONFIGURAÇÃO DOS COMANDOS SLASH DO DISCORD =====
const commands = [
  new SlashCommandBuilder()
    .setName('up')
    .setDescription('Cria um canal privado para upload de bots'),
  
  new SlashCommandBuilder()
    .setName('upload')
    .setDescription('Faz upload de um bot em formato ZIP')
    .addAttachmentOption(option => 
      option.setName('arquivo')
        .setDescription('Arquivo ZIP contendo o bot')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('nome')
        .setDescription('Nome para o bot (opcional)')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra o status dos bots em execução'),
  
  new SlashCommandBuilder()
    .setName('parar')
    .setDescription('Para um bot em execução')
    .addStringOption(option => 
      option.setName('id')
        .setDescription('ID do bot')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('iniciar')
    .setDescription('Inicia um bot parado')
    .addStringOption(option => 
      option.setName('id')
        .setDescription('ID do bot')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Mostra os logs de um bot')
    .addStringOption(option => 
      option.setName('id')
        .setDescription('ID do bot')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('excluir')
    .setDescription('Exclui um bot')
    .addStringOption(option => 
      option.setName('id')
        .setDescription('ID do bot')
        .setRequired(true))
];

// ===== REGISTRO DOS COMANDOS SLASH =====
async function registerCommands() {
  try {
    console.log('Iniciando registro de comandos slash...');
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    
    console.log('✅ Comandos slash registrados com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao registrar comandos slash:', error);
  }
}

// ===== FUNÇÕES PARA DOWNLOAD DE ARQUIVOS DO DISCORD =====
async function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    
    https.get(url, response => {
      response.pipe(file);
      
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', error => {
      fs.unlink(filePath, () => {});
      reject(error);
    });
  });
}

// ===== EVENTO DE INICIALIZAÇÃO DO BOT =====
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot Discord logado como ${client.user.tag}`);
  
  // Certificar-se de que o cliente.user está na cache
  if (client.users && client.user && !client.users.cache.has(client.user.id)) {
    client.users.cache.set(client.user.id, client.user);
  }
  
  registerCommands();
});

// ===== PROCESSAMENTO DE COMANDOS SLASH =====
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    try {
      switch (commandName) {
        case 'up': {
          await interaction.deferReply({ ephemeral: true });
          
          // Verificar se o usuário já tem um canal privado
          const existingChannel = privateChannels.get(interaction.user.id);
          if (existingChannel) {
            const channel = interaction.guild.channels.cache.get(existingChannel);
            if (channel) {
              await interaction.editReply({
                content: `Você já possui um canal privado: <#${existingChannel}>. Use-o para enviar seu bot.`,
                ephemeral: true
              });
              return;
            } else {
              // Canal não existe mais, remover do registro
              privateChannels.delete(interaction.user.id);
            }
          }
          
          // Criar um novo canal privado
          try {
            const everyoneRole = interaction.guild.roles.cache.find(r => r.name === '@everyone');
            
            const channel = await interaction.guild.channels.create({
              name: `upload-${interaction.user.username}`,
              type: 0, // GUILD_TEXT
              parent: interaction.channel.parentId, // Mesma categoria do canal atual
              permissionOverwrites: [
                {
                  id: interaction.guild.id, // @everyone
                  deny: ['ViewChannel']
                },
                {
                  id: interaction.user.id,
                  allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
                },
                {
                  id: client.user.id, // Bot
                  allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
                }
              ]
            });
            
            // Registrar o canal privado
            privateChannels.set(interaction.user.id, channel.id);
            
            // Enviar mensagem de boas-vindas no canal
            await channel.send({
              content: `👋 Olá ${interaction.user}! Este é seu canal privado para upload de bots.\n\nDigite \`/upload\` e anexe seu arquivo ZIP para começar.`,
              embeds: [
                new EmbedBuilder()
                  .setColor('#7289da')
                  .setTitle('📤 Upload de Bots')
                  .setDescription('Para enviar seu bot, use o comando `/upload` e anexe o arquivo ZIP do seu bot.')
                  .addFields(
                    { name: '📋 Requisitos', value: '• Arquivo ZIP contendo o código fonte do bot\n• Arquivo `index.js` na raiz do ZIP\n• Arquivo `package.json` com as dependências' },
                    { name: '⚙️ Processo', value: '1. Enviar o arquivo ZIP\n2. O sistema irá extrair e instalar dependências\n3. Seu bot será iniciado automaticamente' }
                  )
                  .setFooter({ text: 'Este canal será excluído automaticamente após 1 hora de inatividade' })
              ]
            });
            
            // Informar ao usuário
            await interaction.editReply({
              content: `✅ Canal privado criado com sucesso: <#${channel.id}>. Acesse-o para enviar seu bot.`,
              ephemeral: true
            });
            
            // Programar exclusão automática do canal após 1 hora de inatividade
            setTimeout(() => {
              const channelId = privateChannels.get(interaction.user.id);
              if (channelId) {
                const channel = interaction.guild.channels.cache.get(channelId);
                if (channel) {
                  channel.delete().catch(console.error);
                  privateChannels.delete(interaction.user.id);
                }
              }
            }, 3600000); // 1 hora
          } catch (error) {
            console.error('Erro ao criar canal privado:', error);
            await interaction.editReply({
              content: `❌ Erro ao criar canal privado: ${error.message}. Verifique se o bot tem permissões para gerenciar canais.`,
              ephemeral: true
            });
          }
          
          break;
        }
        
        case 'upload': {
          // Verificar se o comando está sendo usado em um canal privado
          const isPrivateChannel = Array.from(privateChannels.values()).includes(interaction.channelId);
          
          if (!isPrivateChannel) {
            await interaction.reply({
              content: '❌ Este comando só pode ser usado em um canal privado de upload. Use `/up` para criar um canal privado.',
              ephemeral: true
            });
            return;
          }
          
          await interaction.deferReply();
          
          const arquivo = interaction.options.getAttachment('arquivo');
          const nome = interaction.options.getString('nome');
          
          // Verificar o tamanho do arquivo (limite de 50MB)
          if (arquivo.size > 50 * 1024 * 1024) {
            await interaction.editReply('❌ O arquivo excede o limite de 50MB. Por favor, envie um arquivo menor.');
            return;
          }
          
          if (!arquivo.name.endsWith('.zip')) {
            await interaction.editReply('❌ Apenas arquivos ZIP são permitidos!');
            return;
          }
          
          // Baixar o arquivo
          const botId = Date.now().toString();
          const filePath = path.join('discord_uploads', `bot_${botId}.zip`);
          
          await interaction.editReply('⬇️ Baixando arquivo...');
          await downloadFile(arquivo.url, filePath);
          
          await interaction.editReply('📦 Extraindo e configurando bot...');
          
          const discordId = {
            userId: interaction.user.id,
            channelId: interaction.channelId,
            guildId: interaction.guildId
          };
          
          try {
            const bot = await processZipFile(filePath, botId, nome, discordId);
            
            const embed = new EmbedBuilder()
              .setColor('#43b581')
              .setTitle('✅ Bot instalado com sucesso!')
              .setDescription(`O bot **${bot.name}** foi iniciado com sucesso.`)
              .addFields(
                { name: 'ID', value: bot.id, inline: true },
                { name: 'Status', value: 'Em execução', inline: true }
              )
              .setFooter({ text: `Instalado por ${interaction.user.tag}` })
              .setTimestamp();
            
            await interaction.editReply({ content: null, embeds: [embed] });
          } catch (error) {
            await interaction.editReply(`❌ Erro: ${error.message}`);
          }
          break;
        }
        
        case 'status': {
          await interaction.deferReply();
          
          const bots = botRegistry.getUserBots(interaction.user.id);
          
          if (bots.length === 0) {
            await interaction.editReply('📊 Você não possui nenhum bot registrado no momento.');
            return;
          }
          
          const embed = new EmbedBuilder()
            .setColor('#7289da')
            .setTitle('📊 Status dos Seus Bots')
            .setDescription(`Total de bots: ${bots.length}`)
            .setTimestamp();
          
          bots.forEach(bot => {
            const statusEmoji = bot.status === 'running' ? '🟢' : bot.status === 'error' ? '🔴' : '⚪';
            embed.addFields({
              name: `${statusEmoji} ${bot.name}`,
              value: `ID: \`${bot.id}\`\nStatus: ${bot.status === 'running' ? 'Em execução' : bot.status === 'error' ? 'Erro' : 'Parado'}\nCriado em: ${bot.createdAt.toLocaleString()}`
            });
          });
          
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        
        case 'parar': {
          const botId = interaction.options.getString('id');
          
          if (!botRegistry.bots[botId]) {
            await interaction.reply('❌ Bot não encontrado!');
            return;
          }
          
          const bot = botRegistry.bots[botId];
          
          // Verificar se o usuário é o proprietário do bot
          if (!bot.discordId || bot.discordId.userId !== interaction.user.id) {
            await interaction.reply('❌ Você só pode parar bots que você mesmo enviou!');
            return;
          }
          
          if (bot.status !== 'running') {
            await interaction.reply('⚠️ Este bot já está parado.');
            return;
          }
          
          stopBot(botId);
          await interaction.reply(`✅ Bot **${bot.name}** parado com sucesso!`);
          break;
        }
        
        case 'iniciar': {
          const botId = interaction.options.getString('id');
          
          if (!botRegistry.bots[botId]) {
            await interaction.reply('❌ Bot não encontrado!');
            return;
          }
          
          const bot = botRegistry.bots[botId];
          
          // Verificar se o usuário é o proprietário do bot
          if (!bot.discordId || bot.discordId.userId !== interaction.user.id) {
            await interaction.reply('❌ Você só pode iniciar bots que você mesmo enviou!');
            return;
          }
          
          if (bot.status === 'running') {
            await interaction.reply('⚠️ Este bot já está em execução.');
            return;
          }
          
          const started = startBot(botId);
          
          if (!started) {
            await interaction.reply('❌ Falha ao iniciar o bot.');
            return;
          }
          
          await interaction.reply(`✅ Bot **${bot.name}** iniciado com sucesso!`);
          break;
        }
        
        case 'logs': {
          const botId = interaction.options.getString('id');
          
          if (!botRegistry.bots[botId]) {
            await interaction.reply('❌ Bot não encontrado!');
            return;
          }
          
          const bot = botRegistry.bots[botId];
          
          // Verificar se o usuário é o proprietário do bot
          if (!bot.discordId || bot.discordId.userId !== interaction.user.id) {
            await interaction.reply('❌ Você só pode ver logs de bots que você mesmo enviou!');
            return;
          }
          
          if (!fs.existsSync(bot.logFile)) {
            await interaction.reply(`📝 Nenhum log disponível para o bot **${bot.name}**.`);
            return;
          }
          
          const logs = fs.readFileSync(bot.logFile, 'utf8');
          const lastLogs = logs.split('\n').slice(-15).join('\n'); // Últimas 15 linhas
          
          const logAttachment = new AttachmentBuilder(Buffer.from(logs), { name: `logs_${botId}.txt` });
          
          await interaction.reply({
            content: `📝 **Logs do bot ${bot.name}** (últimas linhas):\n\`\`\`\n${lastLogs}\n\`\`\``,
            files: [logAttachment]
          });
          break;
        }
        
        case 'excluir': {
          const botId = interaction.options.getString('id');
          
          if (!botRegistry.bots[botId]) {
            await interaction.reply('❌ Bot não encontrado!');
            return;
          }
          
          const bot = botRegistry.bots[botId];
          
          // Verificar se o usuário é o proprietário do bot
          if (!bot.discordId || bot.discordId.userId !== interaction.user.id) {
            await interaction.reply('❌ Você só pode excluir bots que você mesmo enviou!');
            return;
          }
          
          // Parar o bot se estiver rodando
          if (bot.status === 'running') {
            stopBot(botId);
          }
          
          // Remover diretório e logs
          try {
            fs.rmSync(bot.path, { recursive: true, force: true });
            if (fs.existsSync(bot.logFile)) {
              fs.unlinkSync(bot.logFile);
            }
            botRegistry.remove(botId);
            
            await interaction.reply(`✅ Bot **${bot.name}** excluído com sucesso!`);
          } catch (error) {
            console.error("Erro ao remover bot:", error);
            await interaction.reply('❌ Erro ao excluir o bot.');
          }
          break;
        }
      }
    } catch (error) {
      console.error(`Erro ao processar comando ${commandName}:`, error);
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ Ocorreu um erro ao processar este comando.');
      } else {
        await interaction.reply('❌ Ocorreu um erro ao processar este comando.');
      }
    }
  } catch (error) {
    console.error(`Erro ao processar comando:`, error);
    
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('❌ Ocorreu um erro ao processar este comando.');
    } else {
      await interaction.reply('❌ Ocorreu um erro ao processar este comando.');
    }
  }
async function deployCommands() {
  try {
    if (!TOKEN || TOKEN === 'seu_token_aqui') {
      console.error('❌ Token do Discord não configurado!');
      console.log('Configure-o no arquivo .env ou diretamente no código.');
      return false;
    }
    
    if (!CLIENT_ID || CLIENT_ID === 'seu_client_id_aqui') {
      console.error('❌ Client ID não configurado!');
      console.log('Configure-o no arquivo .env ou diretamente no código.');
      return false;
    }
    
    // Usar o cliente REST configurado globalmente
    console.log('⏳ Registrando comandos slash...');
    
    // Obter comandos formatados
    const commandsData = commands.map(command => command.toJSON());
    
    // Registrar comandos globalmente
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commandsData }
    );
    
    console.log('✅ Comandos slash implantados com sucesso!');
    return true;
  } catch (error) {
    console.error('❌ Erro ao implantar comandos slash:', error);
    return false;
  }
}

// ===== SERVIDOR WEB =====

// Rota principal - Lista de bots
app.get("/", (req, res) => {
  // Nota: Quando implementar autenticação, filtrar por usuário logado
  // Atualmente mostra todos os bots - será atualizado quando a autenticação estiver implementada
  res.render("index", { bots: botRegistry.getList() });
});

// Upload de um novo bot
app.post("/upload", upload.single("botzip"), async (req, res) => {
  try {
    const zipPath = req.file.path;
    const botId = Date.now().toString();
    const botName = req.body.botName || null;
    
    try {
      const bot = await processZipFile(zipPath, botId, botName);
      
      res.send(`
        <h1>✅ Bot instalado com sucesso!</h1>
        <p>ID: ${botId}</p>
        <p>Nome: ${bot.name}</p>
        <p>Status: Em execução</p>
        <a href="/">Voltar para o painel</a>
      `);
    } catch (error) {
      res.status(500).send(`
        <h1>❌ Erro ao instalar o bot</h1>
        <p>${error.message}</p>
        <a href="/">Voltar</a>
      `);
    }
  } catch (error) {
    console.error("Erro no upload:", error);
    res.status(500).send(`
      <h1>❌ Erro no servidor</h1>
      <p>${error.message}</p>
      <a href="/">Voltar</a>
    `);
  }
});

// Rotas para gerenciar bots
app.get("/start/:id", (req, res) => {
  const botId = req.params.id;
  const bot = botRegistry.bots[botId];
  
  if (!bot) {
    return res.status(404).send(`
      <h1>❌ Bot não encontrado</h1>
      <a href="/">Voltar</a>
    `);
  }
  
  // Nota: No futuro, verificar se o usuário autenticado é o proprietário do bot
  // Quando a autenticação estiver implementada, usar:
  // if (bot.discordId && bot.discordId.userId !== req.user.id) { ... }
  
  if (bot.status === 'running') {
    return res.status(400).send(`
      <h1>⚠️ O bot já está em execução</h1>
      <a href="/">Voltar</a>
    `);
  }
  
  const started = startBot(botId);
  
  if (!started) {
    return res.status(400).send(`
      <h1>❌ Falha ao iniciar o bot</h1>
      <p>Ocorreu um erro ao tentar iniciar o bot.</p>
      <a href="/">Voltar</a>
    `);
  }
  
  res.redirect("/");
});

app.get("/stop/:id", (req, res) => {
  const botId = req.params.id;
  const bot = botRegistry.bots[botId];
  
  if (!bot) {
    return res.status(404).send(`
      <h1>❌ Bot não encontrado</h1>
      <a href="/">Voltar</a>
    `);
  }
  
  // Nota: No futuro, verificar se o usuário autenticado é o proprietário do bot
  // Quando a autenticação estiver implementada, usar:
  // if (bot.discordId && bot.discordId.userId !== req.user.id) { ... }
  
  if (bot.status !== 'running') {
    return res.status(400).send(`
      <h1>⚠️ O bot já está parado</h1>
      <a href="/">Voltar</a>
    `);
  }
  
  const stopped = stopBot(botId);
  
  if (!stopped) {
    return res.status(400).send(`
      <h1>❌ Falha ao parar o bot</h1>
      <p>Ocorreu um erro ao tentar parar o bot.</p>
      <a href="/">Voltar</a>
    `);
  }
  
  res.redirect("/");
});

app.get("/logs/:id", (req, res) => {
  const botId = req.params.id;
  const bot = botRegistry.bots[botId];
  
  if (!bot) {
    return res.status(404).send(`
      <h1>❌ Bot não encontrado</h1>
      <a href="/">Voltar</a>
    `);
  }
  
  // Nota: No futuro, verificar se o usuário autenticado é o proprietário do bot
  // Quando a autenticação estiver implementada, usar:
  // if (bot.discordId && bot.discordId.userId !== req.user.id) { ... }
  
  if (!fs.existsSync(bot.logFile)) {
    return res.send(`
      <h1>📝 Logs do Bot ${bot.name}</h1>
      <p>Nenhum log disponível ainda.</p>
      <a href="/">Voltar</a>
    `);
  }
  
  const logs = fs.readFileSync(bot.logFile, 'utf8');
  
  res.send(`
    <h1>📝 Logs do Bot ${bot.name}</h1>
    <pre style="background:#222; color:#fff; padding:15px; border-radius:5px; max-height:500px; overflow:auto;">${logs}</pre>
    <a href="/">Voltar</a>
  `);
});

app.get("/delete/:id", (req, res) => {
  const botId = req.params.id;
  const bot = botRegistry.bots[botId];
  
  if (!bot) {
    return res.status(404).send(`
      <h1>❌ Bot não encontrado</h1>
      <a href="/">Voltar</a>
    `);
  }
  
  // Nota: No futuro, verificar se o usuário autenticado é o proprietário do bot
  // Quando a autenticação estiver implementada, usar:
  // if (bot.discordId && bot.discordId.userId !== req.user.id) { ... }
  
  // Parar o bot se estiver rodando
  if (bot.status === 'running') {
    stopBot(botId);
  }
  
  // Remover diretório e logs
  try {
    fs.rmSync(bot.path, { recursive: true, force: true });
    if (fs.existsSync(bot.logFile)) {
      fs.unlinkSync(bot.logFile);
    }
    botRegistry.remove(botId);
  } catch (error) {
    console.error("Erro ao remover bot:", error);
  }
  
  res.redirect("/");
});

app.get("/refresh", (req, res) => {
  res.redirect("/");
});

// Criar pasta 'public' para arquivos estáticos
if (!fs.existsSync('public')) {
  fs.mkdirSync('public');
  
  // Criar um arquivo CSS básico
  const cssContent = `
  /* Estilos adicionais para o painel */
  .notification {
    padding: 10px;
    margin: 10px 0;
    border-radius: 5px;
    color: white;
  }
  
  .success {
    background-color: #43b581;
  }
  
  .error {
    background-color: #f04747;
  }
  
  .warning {
    background-color: #faa61a;
  }
  `;
  
  fs.writeFileSync(path.join('public', 'styles.css'), cssContent);
}

// Iniciar o servidor e o bot
const server = app.listen(PORT, () => {
  console.log(`✅ Painel online: http://localhost:${PORT}`);
  
  // Verificar se o token foi configurado
  if (!TOKEN) {
    console.error('❌ ERRO: Token do Discord não configurado!');
    console.error('Por favor, configure a variável de ambiente DISCORD_TOKEN com um token válido.');
    console.error('Execute o programa com: DISCORD_TOKEN=seu_token_aqui node index.js');
    console.error('Ou crie um arquivo .env com DISCORD_TOKEN=seu_token_aqui');
    console.log('O painel web continuará funcionando, mas a integração com o Discord está desativada.');
    return;
  }
  
  // Iniciar o bot do Discord
  try {
    console.log('📡 Tentando conectar ao Discord...');
    client.login(TOKEN).then(() => {
      console.log('✅ Bot do Discord conectado com sucesso!');
      
      // Implantar comandos slash após conexão bem-sucedida
      deployCommands().then(success => {
        if (success) {
          console.log('🤖 Bot pronto para uso! Comandos disponíveis:');
          console.log('  /up - Cria um canal privado para upload');
          console.log('  /upload - Envia um bot (apenas em canais privados)');
          console.log('  /status - Mostra os bots em execução');
          console.log('  /logs - Mostra os logs de um bot');
          console.log('  /parar - Para um bot em execução');
          console.log('  /iniciar - Inicia um bot parado');
          console.log('  /excluir - Remove um bot do sistema');
        }
      });
    }).catch(err => {
      console.error('❌ Erro ao conectar ao Discord:', err);
      console.log('⚠️ Possíveis causas:');
      console.log('  1. Token inválido ou revogado');
      console.log('  2. Problemas de conectividade');
      console.log('  3. Intents não autorizadas no Portal do Desenvolvedor Discord');
      console.log('\n📝 Para obter um novo token:');
      console.log('  1. Acesse https://discord.com/developers/applications');
      console.log('  2. Crie ou selecione uma aplicação');
      console.log('  3. Vá para a seção "Bot" e clique em "Reset Token"');
      console.log('  4. Copie o novo token e defina como variável de ambiente DISCORD_TOKEN');
      console.log('  5. Certifique-se de que todas as intents necessárias estão habilitadas');
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar o bot do Discord:', error);
  }
});
})
