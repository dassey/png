/*
 * PNG file chunk inspector library (JavaScript)
 *
 * Copyright (c) 2022 Nayuki
 * All rights reserved. Contact Nayuki for licensing.
 * https://www.nayuki.io/page/png-file-chunk-inspector
 */

"use strict";


var app = new function() {

	/*---- Fields ----*/

	let fileElem = document.getElementById("input-file");
	let analyzeButton = document.getElementById("analyze-button");
	let messageElem = document.getElementById("message");
	let chunkTable = document.getElementById("chunk-table");
	let chunkTableBody = chunkTable.querySelector("tbody");

	const CHUNK_TYPES_TO_DUMP = new Set(["gAMA", "sRGB", "pHYs", "iTXt", "tEXt", "zTXt", "tIME"]);


	/*---- Initialization ----*/

	analyzeButton.onclick = function() {
		messageElem.textContent = "";
		while (chunkTableBody.firstChild !== null)
			chunkTableBody.removeChild(chunkTableBody.firstChild);
		chunkTable.classList.add("hidden");

		let files = fileElem.files;
		if (files.length < 1) {
			messageElem.textContent = "No file selected";
			return;
		}

		let reader = new FileReader();
		reader.onload = function() {
			try {
				let bytes = new Uint8Array(reader.result);
				let chunks = readPngChunks(bytes);
				renderChunks(chunks, bytes);
			} catch (e) {
				messageElem.textContent = e.toString();
			}
		};
		reader.onerror = function() {
			messageElem.textContent = "File reading error";
		};
		messageElem.textContent = "Reading file...";
		reader.readAsArrayBuffer(files[0]);
	};


	/*---- PNG parsing functions ----*/

	// Takes the raw bytes of a PNG file, returns a list of chunk objects, throwing an exception if error.
	function readPngChunks(bytes) {
		// Check file signature
		if (bytes.length < 8 || !bytes.subarray(0, 8).every((b, i) => (b === PNG_SIGNATURE[i])))
			throw "Not a PNG file";

		// Parse chunks
		let chunks = [];
		let index = 8;
		while (index < bytes.length) {
			// Parse chunk header
			if (index + 8 > bytes.length)
				throw "Unexpected end of file (chunk header)";
			let length = readUint32(bytes, index + 0);
			if (length >= 0x80000000)
				throw "Chunk length too large";
			let type = readAscii(bytes, index + 4, 4);
			if (!/^[A-Za-z]{4}$/.test(type))
				throw "Chunk type has invalid characters";

			// Parse chunk data
			if (index + 8 + length + 4 > bytes.length)
				throw "Unexpected end of file (chunk data)";
			let data = bytes.subarray(index + 8, index + 8 + length);

			// Parse chunk CRC
			let actualCrc = readUint32(bytes, index + 8 + length);
			let typeBytes = new Uint8Array(4);
			for (let i = 0; i < 4; i++)
				typeBytes[i] = type.charCodeAt(i);
			let expectedCrc = computeCrc(typeBytes, data);
			if (actualCrc !== expectedCrc)
				throw "Chunk CRC mismatch";

			// Append chunk object
			chunks.push({
				type : type,
				length : length,
				data : data,
				offset : index,
			});
			index += 8 + length + 4;

			// Check for last chunk
			if (type === "IEND" && index !== bytes.length)
				console.log("Warning: File continues after IEND chunk");
		}

		// Check critical chunks
		if (chunks.length === 0 || chunks[0].type !== "IHDR")
			throw "Missing IHDR chunk";
		if (chunks[chunks.length - 1].type !== "IEND")
			throw "Missing IEND chunk";
		let hasIdat = chunks.some(ch => (ch.type === "IDAT"));
		if (!hasIdat)
			throw "Missing IDAT chunk";
		return chunks;
	}


	const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];


	// Computes the CRC-32 of the given byte sequences.
	function computeCrc(type, data) {
		let crc = 0xFFFFFFFF;
		crc = updateCrc(crc, type);
		crc = updateCrc(crc, data);
		return crc ^ 0xFFFFFFFF;
	}


	let crcTable = null;

	// Updates the CRC-32 with the given sequence of bytes.
	function updateCrc(crc, bytes) {
		// Initialize table
		if (crcTable === null) {
			crcTable = new Int32Array(256);
			for (let i = 0; i < 256; i++) {
				let c = i;
				for (let j = 0; j < 8; j++) {
					if ((c & 1) === 0)
						c = c >>> 1;
					else
						c = (c >>> 1) ^ 0xEDB88320;
				}
				crcTable[i] = c;
			}
		}
		// Compute CRC
		for (const b of bytes)
			crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
		return crc;
	}


	/*---- Rendering functions ----*/

	// Renders the given list of chunk objects into the page DOM. Also requires the raw file bytes.
	function renderChunks(chunks, bytes) {
		messageElem.textContent = "File parsed successfully";
		chunkTable.classList.remove("hidden");

		let headers = chunkTable.querySelector("thead tr").cells;
		let colInfos = [];
		for (let i = 0; i < headers.length; i++)
			colInfos.push({name: headers[i].dataset.key, isRight: headers[i].classList.contains("text-right")});

		for (const chunk of chunks) {
			let row = chunkTableBody.insertRow();

			let cells = {};
			for (const info of colInfos) {
				let cell = row.insertCell();
				cell.classList.add("p-2", "border", "border-gray-300");
				if (info.isRight)
					cell.classList.add("text-right");
				cells[info.name] = cell;
			}

			cells.offset.textContent = formatNumber(chunk.offset);
			cells.length.textContent = formatNumber(chunk.length);
			cells.type.textContent = chunk.type;
			cells.crc.textContent = formatHex(readUint32(bytes, chunk.offset + 8 + chunk.length), 8);

			let summary = "";
			try {
				summary = summarizeChunk(chunk);
			} catch (e) {
				summary = e.toString();
			}
			cells.summary.textContent = summary;

			if (CHUNK_TYPES_TO_DUMP.has(chunk.type))
				cells.dump.textContent = dumpChunkData(chunk.data);
		}
	}


	function summarizeChunk(chunk) {
		let data = chunk.data;
		let length = chunk.length;
		switch (chunk.type) {
			case "IHDR": {
				if (length !== 13)
					throw "Invalid length";
				let width = readUint32(data, 0);
				let height = readUint32(data, 4);
				let bitDepth = data[8];
				let colorType = data[9];
				let compressionMethod = data[10];
				let filterMethod = data[11];
				let interlaceMethod = data[12];
				if (width === 0 || height === 0)
					throw "Zero width or height";
				if (!isValidBitDepthColorType(bitDepth, colorType))
					throw "Invalid bit depth and color type combination";
				if (compressionMethod !== 0)
					throw "Invalid compression method";
				if (filterMethod !== 0)
					throw "Invalid filter method";
				if (interlaceMethod !== 0 && interlaceMethod !== 1)
					throw "Invalid interlace method";
				let colorTypeStr;
				switch (colorType) {
					case 0: colorTypeStr = "Grayscale"; break;
					case 2: colorTypeStr = "Truecolor"; break;
					case 3: colorTypeStr = "Indexed-color"; break;
					case 4: colorTypeStr = "Grayscale with alpha"; break;
					case 6: colorTypeStr = "Truecolor with alpha"; break;
					default: throw "Invalid color type";
				}
				return `Width=${width}, Height=${height}, Bit depth=${bitDepth}, Color type=${colorType} (${colorTypeStr}), Compression=${compressionMethod}, Filter=${filterMethod}, Interlace=${interlaceMethod}`;
			}
			case "PLTE": {
				if (length % 3 !== 0)
					throw "Invalid length";
				return `Palette entries=${length / 3}`;
			}
			case "IDAT": {
				return "";
			}
			case "IEND": {
				if (length !== 0)
					throw "Invalid length";
				return "";
			}
			case "tRNS": {
				// Note: This depends on IHDR having been seen
				return "";
			}
			case "cHRM": {
				if (length !== 32)
					throw "Invalid length";
				let whiteX = readUint32(data, 0) / 100000;
				let whiteY = readUint32(data, 4) / 100000;
				let redX = readUint32(data, 8) / 100000;
				let redY = readUint32(data, 12) / 100000;
				let greenX = readUint32(data, 16) / 100000;
				let greenY = readUint32(data, 20) / 100000;
				let blueX = readUint32(data, 24) / 100000;
				let blueY = readUint32(data, 28) / 100000;
				return `White point x=${whiteX}, White point y=${whiteY}, Red x=${redX}, Red y=${redY}, Green x=${greenX}, Green y=${greenY}, Blue x=${blueX}, Blue y=${blueY}`;
			}
			case "gAMA": {
				if (length !== 4)
					throw "Invalid length";
				let gamma = readUint32(data, 0) / 100000;
				return `Gamma=${gamma}`;
			}
			case "iCCP": {
				let nul = data.indexOf(0);
				if (nul === -1)
					throw "Invalid data format";
				let name = readLatin1(data, 0, nul);
				if (!/^[ -~]{1,79}$/.test(name))
					throw "Invalid profile name";
				let compMethod = data[nul + 1];
				if (compMethod !== 0)
					throw "Invalid compression method";
				// let compressedProfile = data.subarray(nul + 2);
				return `Profile name=${name}, Compression method=${compMethod}`;
			}
			case "sBIT": {
				// Note: This depends on IHDR having been seen
				return "";
			}
			case "sRGB": {
				if (length !== 1)
					throw "Invalid length";
				let renderingIntent = data[0];
				let intentStr;
				switch (renderingIntent) {
					case 0: intentStr = "Perceptual"; break;
					case 1: intentStr = "Relative colorimetric"; break;
					case 2: intentStr = "Saturation"; break;
					case 3: intentStr = "Absolute colorimetric"; break;
					default: throw "Invalid rendering intent";
				}
				return `Rendering intent=${renderingIntent} (${intentStr})`;
			}
			case "cICP": {
				if (length !== 4)
					throw "Invalid length";
				let colorPrimaries = data[0];
				let transferCharacteristics = data[1];
				let matrixCoefficients = data[2];
				let videoFullRangeFlag = data[3];
				if (videoFullRangeFlag > 1)
					throw "Invalid video full range flag";
				return `Color primaries=${colorPrimaries}, Transfer characteristics=${transferCharacteristics}, Matrix coefficients=${matrixCoefficients}, Video full range flag=${videoFullRangeFlag}`;
			}
			case "iTXt": {
				let nul0 = data.indexOf(0);
				if (nul0 === -1)
					throw "Invalid data format";
				let keyword = readLatin1(data, 0, nul0);
				if (!/^[ -~]{1,79}$/.test(keyword))
					throw "Invalid keyword";
				if (nul0 + 2 >= length)
					throw "Invalid data format";
				let compFlag = data[nul0 + 1];
				let compMethod = data[nul0 + 2];
				if (compFlag !== 0 && compFlag !== 1)
					throw "Invalid compression flag";
				if (compFlag === 1 && compMethod !== 0)
					throw "Invalid compression method";
				let nul1 = data.indexOf(0, nul0 + 3);
				if (nul1 === -1)
					throw "Invalid data format";
				let langTag = readLatin1(data, nul0 + 3, nul1 - (nul0 + 3));
				let nul2 = data.indexOf(0, nul1 + 1);
				if (nul2 === -1)
					throw "Invalid data format";
				let translatedKeyword = readUtf8(data, nul1 + 1, nul2 - (nul1 + 1));
				// let text = data.subarray(nul2 + 1);
				return `Keyword=${keyword}, Compression flag=${compFlag}, Compression method=${compMethod}, Language tag=${JSON.stringify(langTag)}, Translated keyword=${JSON.stringify(translatedKeyword)}`;
			}
			case "tEXt": {
				let nul = data.indexOf(0);
				if (nul === -1)
					throw "Invalid data format";
				let keyword = readLatin1(data, 0, nul);
				if (!/^[ -~]{1,79}$/.test(keyword))
					throw "Invalid keyword";
				// let text = readLatin1(data, nul + 1, length - (nul + 1));
				return `Keyword=${keyword}`;
			}
			case "zTXt": {
				let nul = data.indexOf(0);
				if (nul === -1)
					throw "Invalid data format";
				let keyword = readLatin1(data, 0, nul);
				if (!/^[ -~]{1,79}$/.test(keyword))
					throw "Invalid keyword";
				if (nul + 1 >= length)
					throw "Invalid data format";
				let compMethod = data[nul + 1];
				if (compMethod !== 0)
					throw "Invalid compression method";
				// let compressedText = data.subarray(nul + 2);
				return `Keyword=${keyword}, Compression method=${compMethod}`;
			}
			case "bKGD": {
				// Note: This depends on IHDR and PLTE having been seen
				return "";
			}
			case "hIST": {
				// Note: This depends on PLTE having been seen
				if (length % 2 !== 0)
					throw "Invalid length";
				return `Histogram entries=${length / 2}`;
			}
			case "pHYs": {
				if (length !== 9)
					throw "Invalid length";
				let ppuX = readUint32(data, 0);
				let ppuY = readUint32(data, 4);
				let unitSpec = data[8];
				let unitStr;
				if (unitSpec === 0)
					unitStr = "Unknown";
				else if (unitSpec === 1)
					unitStr = "Metre";
				else
					throw "Invalid unit specifier";
				return `Pixels per unit X=${ppuX}, Pixels per unit Y=${ppuY}, Unit specifier=${unitSpec} (${unitStr})`;
			}
			case "sPLT": {
				let nul = data.indexOf(0);
				if (nul === -1)
					throw "Invalid data format";
				let name = readLatin1(data, 0, nul);
				if (!/^[ -~]{1,79}$/.test(name))
					throw "Invalid palette name";
				if (nul + 1 >= length)
					throw "Invalid data format";
				let sampleDepth = data[nul + 1];
				if (sampleDepth !== 8 && sampleDepth !== 16)
					throw "Invalid sample depth";
				let numEntries = (length - (nul + 1 + 1)) / (sampleDepth / 8 * 4 + 2);
				if (Math.floor(numEntries) !== numEntries)
					throw "Invalid data length";
				return `Palette name=${name}, Sample depth=${sampleDepth}, Entries=${numEntries}`;
			}
			case "eXIf": {
				return "";
			}
			case "tIME": {
				if (length !== 7)
					throw "Invalid length";
				let year = readUint16(data, 0);
				let month = data[2];
				let day = data[3];
				let hour = data[4];
				let minute = data[5];
				let second = data[6];
				if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60)
					throw "Invalid date/time value";
				return `Year=${year}, Month=${month}, Day=${day}, Hour=${hour}, Minute=${minute}, Second=${second}`;
			}
			case "acTL": {
				if (length !== 8)
					throw "Invalid length";
				let numFrames = readUint32(data, 0);
				let numPlays = readUint32(data, 4);
				return `Number of frames=${numFrames}, Number of plays=${numPlays}`;
			}
			case "fcTL": {
				if (length !== 26)
					throw "Invalid length";
				let sequenceNumber = readUint32(data, 0);
				let width = readUint32(data, 4);
				let height = readUint32(data, 8);
				let xOffset = readUint32(data, 12);
				let yOffset = readUint32(data, 16);
				let delayNum = readUint16(data, 20);
				let delayDen = readUint16(data, 22);
				let disposeOp = data[24];
				let blendOp = data[25];
				if (width === 0 || height === 0)
					throw "Zero width or height";
				if (disposeOp > 2)
					throw "Invalid dispose operation";
				if (blendOp > 1)
					throw "Invalid blend operation";
				return `Sequence number=${sequenceNumber}, Width=${width}, Height=${height}, X offset=${xOffset}, Y offset=${yOffset}, Delay numerator=${delayNum}, Delay denominator=${delayDen}, Dispose operation=${disposeOp}, Blend operation=${blendOp}`;
			}
			case "fdAT": {
				if (length < 4)
					throw "Invalid length";
				let sequenceNumber = readUint32(data, 0);
				return `Sequence number=${sequenceNumber}`;
			}
			default: {
				if (/^[a-z]/.test(chunk.type))
					return "Ancillary chunk";
				else
					return "Critical chunk";
			}
		}
	}


	function isValidBitDepthColorType(bitDepth, colorType) {
		if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
		if (colorType === 2) return [8, 16].includes(bitDepth);
		if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
		if (colorType === 4) return [8, 16].includes(bitDepth);
		if (colorType === 6) return [8, 16].includes(bitDepth);
		return false;
	}


	function dumpChunkData(data) {
		const BYTES_PER_LINE = 16;
		let s = "";
		for (let i = 0; i < data.length; i += BYTES_PER_LINE) {
			let slice = data.subarray(i, Math.min(i + BYTES_PER_LINE, data.length));
			for (let j = 0; j < slice.length; j++)
				s += formatHex(slice[j], 2) + " ";
			if (slice.length < BYTES_PER_LINE)
				s += " ".repeat((BYTES_PER_LINE - slice.length) * 3);
			s += " |";
			for (let j = 0; j < slice.length; j++) {
				let c = slice[j];
				if (0x20 <= c && c <= 0x7E)
					s += String.fromCharCode(c);
				else
					s += ".";
			}
			s += "|\n";
		}
		return s.replace(/\n$/, "");
	}


	/*---- Utilities ----*/

	function readUint16(bytes, offset) {
		return (bytes[offset] << 8) | bytes[offset + 1];
	}

	function readUint32(bytes, offset) {
		return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
	}

	function readAscii(bytes, offset, len) {
		let result = "";
		for (let i = 0; i < len; i++)
			result += String.fromCharCode(bytes[offset + i]);
		return result;
	}

	function readLatin1(bytes, offset, len) {
		return readAscii(bytes, offset, len);
	}

	function readUtf8(bytes, offset, len) {
		return new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(offset, offset + len));
	}

	function formatNumber(n) {
		return n.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,");
	}

	function formatHex(n, digits) {
		return n.toString(16).toUpperCase().padStart(digits, "0");
	}

};
