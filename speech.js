const {Readable} = require('stream');
const fs = require('fs');
const speech = require('@google-cloud/speech');
const {TextToSpeechClient} = require('@google-cloud/text-to-speech');
//const ps = require('pocketsphinx').ps;


module.exports.text2speech = async function(message) {
    // Creates a client
    // https://cloud.google.com/text-to-speech
    const client = new TextToSpeechClient();

    // Construct the request
    const request = {
        input: {text: message},
        // Select the language and SSML voice gender (optional)
        voice: {languageCode: 'de-DE', "name": "de-DE-Neural2-F"},//ssmlGender: 'FEMALE',
        // Select the type of audio encoding
        audioConfig: {audioEncoding: 'MP3', "pitch": 0.0, "speakingRate": 1}, //model: "waveform", 
    };

    // Performs the text-to-speech request
    const [response] = await client.synthesizeSpeech(request);
    // Get the audio content from response
    const audioContent = response.audioContent;

    return audioContent;
}

module.exports.speech2textGoogle = async function(filename,languageCode) {
    try {
        const client = new speech.SpeechClient();

        const lang = languageCode || 'de-DE';
        const file = fs.readFileSync(filename);
        //console.log("audio file ("+filename+")", file);
        const audioBytes = file.toString('base64');
        //console.log("audioBytes ", audioBytes);

        const audio = {
            content: audioBytes,
        };
        const config = {
            encoding: 'OGG_OPUS',
            sampleRateHertz: 48000,
            languageCode: lang,
        };
        const request = {
            audio: audio,
            config: config,
        };

        return await client
            .recognize(request)
            .then(data => {
                const response = data[0];
                const transcription = response.results
                  .map(result => result.alternatives[0].transcript)
                  .join('\n');
                //console.log(`Transcription: ${transcription}`);

                return transcription;
            })
            .catch(err => {
                console.error('ERROR:', err);
            });
    } catch(err) {
        if( err ) console.error(err);
    }
}

module.exports.speech2textPocketsphinx = async function(filename,languageCode) {
    // Initialize pocketsphinx.
    const config = new ps.Decoder.defaultConfig();
    config.setString("-hmm", "cmusphinx-voxforge-de.lm.bin");
    config.setString("-dict", "cmusphinx-voxforge-de.dic");
    const decoder = new ps.Decoder(config);

    // Read the audio file.
    const audio = fs.readFileSync(filename);

    // Start the decoder.
    decoder.startUtt();
    decoder.processRaw(audio, false, false);
    decoder.endUtt();

    const result = decoder.hyp().hypstr;
    // Get the result.
    console.log(result);
    return result;
}

module.exports.speech2textWhisper = async function(filename,languageCode) {
    const { exec } = require('child_process');

    const mp3file = await new Promise( (resolve,reject)=> {
        exec(`ffmpeg -i ${filename} -acodec libmp3lame ${filename}.mp3`, (err, stdout, stderr) => {
            if (err) {
              return reject(err);
            }
            return resolve(`${filename}.mp3`);
        });
    });

    const whispered = new Promise( (resolve,reject)=> {
        exec(`whisper ${mp3file} --language ${languageCode || 'de'} --model large --task transcribe --temperature 0`, (err, stdout, stderr) => {
          if (err) {
            return reject(err);
          }

          const lines = stdout.split("\n");
          let content = '';

          lines.forEach(line => {
            const text = line.split("]")[1];
            if(text) {
                content += `${text}`.trim();
            }
          });

          return resolve(content);
        });
    });

    return whispered;
}

module.exports.speech2text = module.exports.speech2textGoogle;