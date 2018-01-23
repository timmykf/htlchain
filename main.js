
'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");
var cors = require("cors");
var jsonfl = require('jsonfile');
var cron = require('node-cron');
var fs = require('fs');
var ip = require('ip');

var bcfile = './tmp/coinsafe.json';
var debugfl = './tmp/hcoinsave.txt';
var peersfl = './tmp/standpeers.json';


var task = cron.schedule('*/3 * * * *',function(){
    console.log("tmpsave"+":"+new Date().getTime() / 1000);
});

task.start();

var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

class Block {
    constructor(index, previousHash, timestamp, data, hash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
    }
}

var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};

var urlencodedParser = bodyParser.urlencoded({extended:false});

var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "my genesis block!!", "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7");
};

var blockchain = [getGenesisBlock()];

var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());
    app.use(cors());
    app.get('/blocks', function(req, res) { 
        res.send(JSON.stringify(blockchain));
    });
    app.post('/mineBlock',urlencodedParser, (req, res) => {

        console.log(req.body.name);
        var newBlock = generateNextBlock(req.body.name +":"+req.body.val);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send("DONE");
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => '-------'+s._socket.remoteAddress + ':' + s._socket.remotePort  + '-------\n\r'));
        console.log(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer',urlencodedParser, (req, res) => {
        var peeradd = req.body.address;
        console.log(peeradd);
        var tpr = 'ws://'+peeradd;
        console.log(tpr);
        connectToPeers([tpr]);
        res.send("DONE");
    });
    app.listen(http_port,ip.address(), () => console.log('Listening on: '+ ip.address()+':'+ http_port));
};


var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);

};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
    writepeers((err)=>{
        if(err) throw err;
        console.log("Peer saved");
    })
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var generateNextBlock = (blockData) => {
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
};


var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
};

var calculateHash = (index, previousHash, timestamp, data) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
        writedebug("Block:  " + newBlock.index + "     chained at " + new Date().getTime() / 1000 + "from User: "+ip.address());
        writecontentbcf((err)=>{
            console.log("Blockchain saved");
        });
    }
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed');
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
            writecontentbcf((err)=>{
                console.log("Blockchain saved");
            });
            writedebug("Blockchain:  " + latestBlockReceived.index + "     appended at " + new Date().getTime() / 1000 + "to Chain");
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
            writedebug("Blockchain:  " + getLatestBlock.index + "     sent at " + new Date().getTime() / 1000 + "to All User");
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
            writecontentbcf((err)=>{
                console.log("Blockchain saved");
            });
        }
    } else {
        console.log('received blockchain is not longer than received blockchain. Do nothing');
    }
};

var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

var readcontdebug = (cb) =>{
    fs.readFile('./tmp/hcoinsave.txt',(err,data)=> {
        if(err) throw err;
        cb(null,data);
    })
}
var writedebug = (data) => fs.appendFile(debugfl,data + "\r\n",(err)=> {
    if(err) throw err;
    console.log("Debugfile upduted")
})

var writepeers = (canbok) =>{
    var zw = sockets.map(s => "ws://"+ s._socket.remoteAddress + ':' + s._socket.remotePort);
    console.log(zw);
    jsonfl.writeFile(peersfl, zw ,(err)=>{
        if(err) throw err;
        canbok(null);
    })
}

var readpeers = (snobu)=>{
    jsonfl.readFile(peersfl,(err,obj)=>{
        if(err)throw err;
        snobu(null,obj);
    })
}
 
var readcontentbcf = (cb) =>{
    jsonfl.readFile(bcfile,(err,obj)=>{
        if(err) throw err;
        cb(null,obj);
    })
}
var writecontentbcf = (collbuk)=>{
    jsonfl.writeFile(bcfile,blockchain,(err)=>{
        if(err) throw err;
        collbuk(null);
    })
}

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
readcontentbcf((err,data)=>{
    console.log(data);
    blockchain = data;
})

readpeers((err,obj)=>{
    console.log(obj.length);
    console.log(obj[0]);
    if(err){throw err};
    for(var i= 0; i < obj.length;i++){
        console.log(obj[i]);
        connectToPeers([obj[i]]);
    }
})



