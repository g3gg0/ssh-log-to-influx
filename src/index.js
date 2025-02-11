import log4js from 'log4js'
import net from 'net';
import ngeohash from 'ngeohash'

import parser from './parser'
import doApiCall from './api';

let logger = log4js.getLogger();
logger.level = process.env.DEBUG_LEVEL || 'info';

const Influx = require('influx');
// InfluxDB Initialization.
const influx = new Influx.InfluxDB({
	database: process.env.INFLUX_DB,
	protocol: process.env.INFLUX_PROTOCOL || 'http',
	host: process.env.INFLUX_HOST || process.env.INFLUX_URL,
	port: parseInt(process.env.INFLUX_PORT) || 8086,
	username: process.env.INFLUX_USER || 'root',
	password: process.env.INFLUX_PWD || 'root',
});

createInfluxDatabase();

const dgram = require('dgram');

const port = process.env.PORT || 7070;
const server_udp = dgram.createSocket('udp4');
const server = net.createServer();

async function parse(data) {
	try {
		logger.debug('Received data', data.toString())
		const { ip, port, username } = parser(data.toString())
		logger.debug(`Parsed ${username} ${ip} ${port}`)

		const ipLocation = await doApiCall(ip);

		if (!ipLocation) {
			logger.error('No data retrieved, cannot continue')
			return
		}

		const geohashed = ngeohash.encode(ipLocation.lat, ipLocation.lon);
		logger.debug(`Geohashing with lat: ${ipLocation.lat}, lon: ${ipLocation.lon}: ${geohashed}`)

		// Remove lon and lat from tags
		const { lon, lat, ...others } = ipLocation;

		influx.writePoints([
			{
				measurement: 'geossh',
				fields: {
					value: 1
				},
				tags: {
					geohash: geohashed,
					username,
					port,
					ip,
				location: `${ipLocation.regionName}, ${ipLocation.city}`,
					...others
				}
			}
		]);
	} catch (e) {
		logger.error('An error has occurred processing one connection:', e.message)
	}
}

server_udp.on('message', (data, rinfo) => {
		try {
			parse(data);
		} catch (e) {
			logger.error('An error has occurred processing one connection:', e.message)
		}
});
server_udp.on('listening', () => {
	const address = server.address();
	logger.info(`UDP Server is running on port ${address}:${port}.`);
});
server_udp.bind(port);


server.on('connection', (socket) => {

	logger.info(`CONNECTED: ${socket.remoteAddress}:${socket.remotePort}`)

	socket.on('data', async (data) => {
		try {
			socket.end()

			parse(data);
		} catch (e) {
			logger.error('An error has occurred processing one connection:', e.message)
		}
	})

	socket.on('close', () => {
		logger.info(`CLOSED: ${socket.remoteAddress}:${socket.remotePort}`)
	});
});

server.listen(port, () => {
	logger.info(`TCP Server is running on port ${port}.`);
});

async function createInfluxDatabase() {
	try {
		await influx.createDatabase(process.env.INFLUX_DB);
	} catch(error) {
		logger.error(`Error creating InfluxDB database: ${error}. Retrying in 10s.`);
		setTimeout(createInfluxDatabase, 10000);
	}
}