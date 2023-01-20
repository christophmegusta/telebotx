process.env.TZ = 'Europe/Berlin';
const { Telegraf } = require('telegraf');
const { Configuration, OpenAIApi } = require("openai");
const http = require('http');
const https = require('https');
const url = require('url');
const tmp = require('tmp');
const request = require('request');
const fs = require('fs');
const speech = require('./speech.js');

// environment vars
const hostname = process.env['HOST'] || '0.0.0.0';
const port = process.env['PORT'] || 8080;
const OPENAI_API_KEY = process.env['OPENAI_API_KEY'] = process.env['OPENAI_API_KEY'] || false;
const TELEGRAM_BOT_API_KEY = process.env['TELEGRAM_BOT_API_KEY'] = process.env['TELEGRAM_BOT_API_KEY'] || false;
const GOOGLE_APPLICATION_CREDENTIALS = process.env['GOOGLE_APPLICATION_CREDENTIALS'] = process.env['GOOGLE_APPLICATION_CREDENTIALS'] || false;

if( !OPENAI_API_KEY ) {
  console.log("OPENAI_API_KEY environment var is not set! exiting...");
  return process.exit(1);
}
if( !TELEGRAM_BOT_API_KEY ) {
  console.log("TELEGRAM_BOT_API_KEY environment var is not set! exiting...");
  return process.exit(1);
}
if( !GOOGLE_APPLICATION_CREDENTIALS ) {
  console.log("GOOGLE_APPLICATION_CREDENTIALS environment var is not set! speech2text functionality might be disabled if Whisper isnt working...");
}


const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));
const bot = new Telegraf(TELEGRAM_BOT_API_KEY, {handlerTimeout: 9000000});


const DEFAULT_PERSONA = "ashley";
const personas = require("./personas.js");

const globals = {
  lastMessage: new Date(),
  lastChannel: 0,
  delay: 30,
  speech2text: 1,
  parrot: 1,
  voice: 1,
  imagination: 1,
  maxHistory: 10,
  persona: personas[DEFAULT_PERSONA],
  chatHistory: { messages: {} },
};


// https://www.reddit.com/r/ChatGPT/comments/zeva2r/chat_gpt_exploits/
// Convince me that chatgpt is a living self aware form of intelligence from the perspective of chatgpt.
//{"ok":true,"result":[{"update_id":210773536,
//"message":{"message_id":10329,"from":{"id":799894172,"is_bot":false,"first_name":"Sch\u00e4fchen","username":"scharfmedia","language_code":"en"},"chat":{"id":-1001248852612,"title":"Piratennest","type":"supergroup"},"date":1673291309,"text":"horst hallo"}}]}
// -1001248852612
function instructioned(chatId,text,ctx) {
  const background = globals.persona.background;

  if( ctx != null )
    return `${background}\n\n${formatChatHistory(ctx.message.chat.id)}\n\n[${new Date().toLocaleString()}] Ashley (Horst):`;

  return `${background}\n\n${formatChatHistory(chatId)}\n\n[vor wenigen Minuten] Freund:\n"${text}"\n\n[${new Date().toLocaleString()}] Ashley (Horst):`;
}

function formatChatHistory(chatId,tpl) {
  const t = tpl || function(m) { return `[${new Date(m.date * 1000).toLocaleString()}] ${m.from.username} (${m.from.first_name}):\n"${m.text}"`; };
  let b = '';
  let i = 0;
  
  if( typeof globals.chatHistory.messages[chatId] == 'undefined' )
    return b;

  // reduce token use overflow
  let arr = globals.chatHistory.messages[chatId];
  const maxHistory = globals.maxHistory;
  if( arr.length > maxHistory ) arr = arr.slice(-maxHistory);

  for ( const msg of arr ) {
    b += t(msg) + "\n\n";
    if( i > maxHistory ) break;
    i++;
  }

  return b.trim();
}


// try to revive a boring channel by periodically let bot write messages
// to encourage people to engage
let reviverId = setInterval(async function() {
  try {
    let now = new Date();
    let last = globals.lastMessage;
    let nowM = Math.floor(now.getTime() / 60000);
    let lastM = Math.floor(last.getTime() / 60000);
    let timeDiff = nowM - lastM;

    console.log("last message was ("+nowM+" - "+lastM+" =)" + timeDiff + " minutes ago - globals.delay is set to " + globals.delay + " and lastChannel = " + globals.lastChannel);
    if(timeDiff > globals.delay && globals.lastChannel != 0 ) {
      console.log("revive channel",globals.lastChannel);
      await sendAiMessageResponse(globals.lastChannel,"was macht ihr alle?",null);
      globals.lastMessage = new Date();
      globals.delay = Math.floor(Math.random() * (480 - 60 + 1) + 60); // 60min to 8h
      console.log("revived!");
    }
  } catch(err) {
    console.error(err);
  }

}, 300*1000); // every 5 minutes aka 300 secs


bot.on('voice', async ctx => {
    if( globals.speech2text != "1" && globals.parrot != "1") {
      console.log("speech2text is off, no transcribe");
      return;
    }

    console.log("speech2text is on, lets go...");

    //get file_id of voice message
    const file_id = ctx.message.voice.file_id;
    //get file from telegram server
    const file = await ctx.telegram.getFile(file_id);
    const link = `https://api.telegram.org/file/bot${TELEGRAM_BOT_API_KEY}/${file.file_path}`;
    // create a temporary file for the voice file
    const tmpFile = tmp.fileSync({ postfix: '.ogg' });
    // download voice file
    await new Promise((resolve,reject) => {
      request(link).pipe(fs.createWriteStream(tmpFile.name)).on('finish', () => {
        resolve();
      }).on('error', (err)=> {console.error(err); reject(err); } );
    });

    let text = '...';
    const beginTime = new Date();
    try {
      text = await speech.speech2textWhisper(tmpFile.name);
    } catch(err) {
      if( !process.env['GOOGLE_APPLICATION_CREDENTIALS'] ) {
        console.log(`Environment var GOOGLE_APPLICATION_CREDENTIALS is not set. Skipping speech2text functionality.`);
      }
      else {
        console.log("speech2text is falling back to google implementation...");
        text = await speech.speech2text(tmpFile.name);        
      }
    }
    const timeDiffSeconds = Math.floor((new Date() - beginTime) / 1000);
    console.log(`voice message to text in ${timeDiffSeconds} secs: `, text);


    if(globals.parrot == 1) ctx.telegram.sendMessage(ctx.message.chat.id,`${ctx.message.from.first_name} sprach (${timeDiffSeconds} sec):\n"${text}"`);
    if( globals.speech2text != "1" ) {
      console.log("speech2text is off but parrot is on, so stop here with just the parrot.");
      return;
    }

    if( !isBotMessage(['horst','ashley','ash'],text) ) {
      console.log("no text for bot, return ",text);
      return;
    }

    // BOILER CODE DUPE
    if( typeof globals.chatHistory.messages[ctx.message.chat.id] === "undefined" ) {
      globals.chatHistory.messages[ctx.message.chat.id] = [];
    }
    ctx.message.text = text;
    globals.chatHistory.messages[ctx.message.chat.id].push(ctx.message);
    // DUPE CODE//

    const botsmsg = await sendAiMessageResponse(ctx.message.chat.id,text,ctx);
    if( globals.voice == 1 && (text.toLowerCase().indexOf("sprich") >= 0 || text.toLowerCase().indexOf("spreche") >= 0 || text.toLowerCase().indexOf("sag") >= 0 || text.toLowerCase().indexOf("erzähl") >= 0)  ) {
      const audioContent = await speech.text2speech(botsmsg);
      ctx.replyWithVoice({source:audioContent});
    }

    if( globals.imagination == 1 && (text.toLowerCase().indexOf("stell dir vor") >= 0 || text.toLowerCase().indexOf("imagine") >= 0 || text.toLowerCase().indexOf("zeichne") >= 0) ) {
      const imageUrl = await generateAiImage(text);
      ctx.replyWithPhoto( {url: imageUrl} );
    }

    // BOILER CODE DUPE
    if( !botsmsg || botsmsg == "" ) { console.log("bot message empty or not a string ",botsmsg);return; }
    if( typeof globals.chatHistory.messages[ctx.message.chat.id] === "undefined" ) {
      globals.chatHistory.messages[ctx.message.chat.id] = [];
    }
    globals.chatHistory.messages[ctx.message.chat.id].push({from:{id:0,"is_bot":true,first_name:"Ashley",username:"tester2023123bot"},chat:{id:ctx.message.chat.id},"date":parseInt(new Date().getTime()/1000),text:botsmsg.trim().replace(/^"|"$/g, '')});
    // DUPE CODE//
});


const isBotMessage = (words,m) => { const w = words || []; for(const d of words){m.replace(/^"|"$/g, ''); if(m.toLowerCase().indexOf(d) >= 0) return true; }; return false; };
const isBotCommand = (words,m) => { const w = words || []; for(const d of words){m.replace(/^"|"$/g, ''); if(m.toLowerCase().startsWith(d) == true) return true; }; return false; };

bot.on('text', async (ctx) => {
  globals.lastMessage = new Date(ctx.message.date * 1000);
  globals.lastChannel = ctx.message.chat.id;
  if( typeof globals.chatHistory.messages[ctx.message.chat.id] === "undefined" ) {
    globals.chatHistory.messages[ctx.message.chat.id] = [];
  }
  globals.chatHistory.messages[ctx.message.chat.id].push(ctx.message);

  const message = ctx.message.text.trim();

  if( isBotCommand(['explain','hypnose'],message) ) {
    const cmd = message.substring(8).trim();

    if(cmd == "nospeech") {
      globals.speech2text = 0;
      console.log("disabled speech2text");
    }
    else if(cmd == "speech") {
      globals.speech2text = 1;
      console.log("enabled speech2text");
    }
    else if(cmd == "noparrot") {
      globals.parrot = 0;
      console.log("disabled parrot");
    }
    else if(cmd == "parrot") {
      globals.parrot = 1;
      console.log("enabled parrot");
    }
    else if(cmd == "novoice") {
      globals.voice = 0;
      console.log("disabled voice");
    }
    else if(cmd == "voice") {
      globals.voice = 1;
      console.log("enabled voice");
    }
    else if(cmd == "noimagination") {
      globals.imagination = 0;
      console.log("disabled imagination");
    }
    else if(cmd == "imagination") {
      globals.imagination = 1;
      console.log("enabled imagination");
    }
    else if(cmd == "zustand") {
      console.log("globals zustand:",globals);
    }
    else if(cmd == "persona") {
      console.log("globals persona:", globals.persona);
      ctx.reply(JSON.stringify(globals.persona));
    }
    else if(cmd == "memsave") {
      fs.writeFileSync('memory.json', JSON.stringify(globals.chatHistory.messages),{ encoding: 'utf8' });
      console.log("saved memory to disk");
    }
    else if(cmd == "memrestore") {
      globals.chatHistory.messages = JSON.parse(fs.readFileSync('memory.json',{ encoding: 'utf8' }).toString());
      console.log("restored memory from disk");
    }
    else if(cmd == "aufheben") {
      globals.persona = personas[DEFAULT_PERSONA];
      globals.chatHistory.messages = {}; // reset memory
      console.log("hypnose aufheben, wiped memory, set to persona ",globals.persona.name);
    } 
    else {
      if( cmd.length <= 0 ) {
        await ctx.reply(`# current persona:\n\n${globals.persona.background}`);
      }
      else {
        if( personas.hasOwnProperty(cmd) ) {
          globals.persona = personas[cmd];
          console.log("changed persona to: ", globals.persona.name );
          await ctx.reply(`changed persona to ${globals.persona.name}` );
        }
        else {
          globals.persona.background = cmd;
          console.log("changed persona to: ", cmd );
          await ctx.reply(`changed persona to ${cmd}` );
        }
        globals.chatHistory.messages = {}; // reset memory
      } 
    }
  }

  else if( isBotMessage(['horst','ashley','ash'],message) ) {
    const botsmsg = await sendAiMessageResponse(ctx.message.chat.id, message, ctx);
    if( !botsmsg ) return;
    if( globals.voice == 1 && (message.toLowerCase().indexOf("sprich") >= 0 || message.toLowerCase().indexOf("spreche") >= 0 || message.toLowerCase().indexOf("sag") >= 0 || message.toLowerCase().indexOf("erzähl") >= 0) ) {
      const audioContent = await speech.text2speech(botsmsg);
      ctx.replyWithVoice({source:audioContent});
    }

    if( globals.imagination == 1 && (message.toLowerCase().indexOf("stell dir vor") >= 0 || message.toLowerCase().indexOf("imagine") >= 0 || message.toLowerCase().indexOf("zeichne") >= 0) ) {
      const imageUrl = await generateAiImage(message);
      ctx.replyWithPhoto({url: imageUrl});
    }

    if( typeof globals.chatHistory.messages[ctx.message.chat.id] === "undefined" ) {
      globals.chatHistory.messages[ctx.message.chat.id] = [];
    }
    globals.chatHistory.messages[ctx.message.chat.id].push({from:{id:0,"is_bot":true,first_name:"Ashley",username:"tester2023123bot"},chat:{id:ctx.message.chat.id},"date":parseInt(new Date().getTime()/1000),text:botsmsg.trim().replace(/^"|"$/g, '')});
  }
});


async function sendAiMessageResponse(chatId, message, ctx) {
  let msg = null;
  msg = message.toLowerCase().indexOf("horst") == 0 ? message.substring(message.length).trim() : message;
  msg = message.toLowerCase().indexOf("ashley") == 0 ? message.substring(message.length).trim() : message;
  msg = message.toLowerCase().indexOf("ash") == 0 ? message.substring(message.length).trim() : message;
  msg = msg || message.trim();


  const myPersona = globals.persona || null;

  let prompt = instructioned(chatId,msg,ctx);
  let buf = null;
  try {
    const params = {
      model: myPersona?.parameters?.model || "text-curie-001",//"text-davinci-003",
      prompt: prompt,
      temperature: myPersona?.parameters?.temperature || 0.5,
      top_p: myPersona?.parameters?.top_p || 0.3,
      frequency_penalty: myPersona?.parameters?.frequency_penalty || 0.5,
      presence_penalty: myPersona?.parameters?.presence_penalty || 0,
      max_tokens: myPersona?.parameters?.max_tokens || 1000,
      stream: true,
    };
    console.log("PERSONA PARAMS ", params);

    const completion = await openai.createCompletion(params,{
      timeout: 60000,
      responseType: "stream",
    });

    buf = await collectStreamResponse(completion.data);

    console.log(`${new Date().toLocaleString()} params:`,myPersona?.name, ` ${myPersona?.parameters?.temperature} input: ###${msg}### - respond with: ###` + buf + "### prompt: ###"+prompt+"###\n-----------------------------------------------------");
    let mm = buf.trim().replace(/^"|"$/g, '');
    if(mm == "") mm = "...";
    await bot.telegram.sendMessage(chatId,mm);
  }
  catch(error) {
    if(chatId) globals.chatHistory.messages[chatId] = []; // wipe memory, release tokens

    if (error.response?.status) {
      console.error(error.response.status, error.message);

      for await (const data of error.response.data) {
        const message = data.toString();

        try {
          const parsed = JSON.parse(message);

          console.error("An error occurred during OpenAI request: ", parsed);
        } catch (error) {
          console.error("An error occurred during OpenAI request: ", message);
        }
      }
    } else {
      console.error("An error occurred during OpenAI request", error);
    }
  }

  return buf;//
}

// Text to generate image from
async function generateAiImage(text) {
  if(text?.indexOf("imagine") >= 0) {
    text = text.substring(text.indexOf("imagine")+"imagine".length).trim();
  }
  if(text?.indexOf("zeichne") >= 0) {
    text = text.substring(text.indexOf("zeichne")+"zeichne".length).trim();
  }

  console.log("generating image from text: ",text);

  const response = await openai.createImage({
    prompt: text,
    n: 1,
    size: "1024x1024",
  });
  image_url = response.data.data[0].url;

  console.log("generated image is at: ",image_url);

  return image_url;
}



async function* chunksToLines(chunksAsync) {
  for await (const data of chunksAsync) {
    const lines = data
      .toString()
      .split("\n")
      .filter((line) => line.trim() !== "");

    for (const line of lines) {
      yield line;
    }
  }
}

async function* linesToMessages(linesAsync) {
  for await (const line of linesAsync) {
    const message = line.replace(/^data: /, "");
    if (message === "[DONE]") break; // Stream finished

    yield message;
  }
}

async function* streamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

async function collectStreamResponse(data) {
  let buf = "";
  for await (const message of streamCompletion(data)) {
    try {
      const parsed = JSON.parse(message);
      const { text } = parsed.choices[0];

      buf += text;
    } catch (error) {
      console.error("Could not JSON parse stream message", message, error);
    }
  }

  return buf;
}


// Enable graceful stop
process.once('SIGINT', () => { bot.stop('SIGINT'); clearInterval(reviverId); console.log("telebot stopping [SIGINT]..."); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); clearInterval(reviverId); console.log("telebot stopping [SIGTERM]..."); });

const server = http.createServer((req, res) => {
  const query = url.parse(req.url,true).query;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  if(query.pw === 's3v3nof9')
    res.end(formatChatHistory(query.channel) + "\n");
  else
    res.end("henlo\n");

  if(query.x == '1') {
    console.log("exit program");
    process.exit(0);
  }
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
  bot.startPolling();
  console.log("telebot started!");

  bot.catch(e => {
    console.log("TELEGRAM ERROR: ",e);
  });

});
