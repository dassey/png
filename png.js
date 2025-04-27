
/*
 * PNG file chunk inspector library (JavaScript)
 *
 * Copyright (c) 2022 Nayuki
 * All rights reserved. Contact Nayuki for licensing.
 * https://www.nayuki.io/page/png-file-chunk-inspector
 *
 * Modified to report CRC errors instead of throwing exceptions.
 * Modified to display decoded text for tEXt/iTXt chunks.
 * Modified to render chunks in separate boxes (2-column layout).
 * Removed summary column. Text content area auto-height.
 * Skip adding text content element if it's just the default placeholder.
 */

"use strict";


var app = new function() {

	/*---- Fields ----*/
	let fileElem = null;
	let analyzeButton = null;
	let messageElem = null;
	let chunkResultsContainer = null;


	/*---- Initialization ----*/
	document.addEventListener('DOMContentLoaded', () => {
		fileElem = document.getElementById("input-file");
		analyzeButton = document.getElementById("analyze-button");
		messageElem = document.getElementById("message");
		chunkResultsContainer = document.getElementById("chunk-results-container");

		// Check if essential elements were found
		if (!analyzeButton) {
			console.error("Analyze button ('analyze-button') not found!");
            if(messageElem) messageElem.textContent = "Page Error: Analyze button missing.";
            return;
		}
        if (!chunkResultsContainer) {
            console.error("Results container ('chunk-results-container') not found!");
            if(messageElem) messageElem.textContent = "Page Error: Results container missing.";
            return;
        }
        if (!fileElem) { console.error("File input element ('input-file') not found!"); }
        if (!messageElem) { console.error("Message element ('message') not found!"); }

		analyzeButton.onclick = analyzeFile;
        // if (fileElem) { fileElem.onchange = analyzeFile; } // Optional: analyze on file select
	});

	// Function to handle the analysis process
	function analyzeFile() {
		// Double-check elements needed for analysis are available
		if (!fileElem || !messageElem || !chunkResultsContainer) {
			console.error("DOM elements not ready or not found for analysis.");
			if (messageElem) messageElem.textContent = "Runtime Error: Page elements missing. Please refresh.";
			return;
		}

		messageElem.textContent = "";
		chunkResultsContainer.innerHTML = ''; // Clear previous boxes

		let files = fileElem.files;
		if (!files || files.length < 1) {
			messageElem.textContent = "No file selected";
			return;
		}

		let reader = new FileReader();

		reader.onload = function() {
			try {
				let bytes = new Uint8Array(reader.result);
                let ihdrInfo = null;
				let parseResult = readPngChunks(bytes);

                 const ihdrChunk = parseResult.chunks.find(c => c.type === 'IHDR');
                 if (ihdrChunk) {
                     try { ihdrInfo = parseIhdrData(ihdrChunk.data); }
                     catch (e) {
                         console.error("Could not parse IHDR data for context:", e);
                         parseResult.warnings.push("Failed to parse IHDR data for context.");
                     }
                 }

				renderChunkBoxes(parseResult.chunks, parseResult.warnings, ihdrInfo); // Call updated render function

				if (parseResult.warnings.length > 0) {
					messageElem.textContent = "File parsed with warnings (see console).";
					messageElem.classList.remove('text-red-600', 'text-green-600');
					messageElem.classList.add('text-yellow-600');
				} else {
					messageElem.textContent = "File parsed successfully.";
					messageElem.classList.remove('text-red-600', 'text-yellow-600');
                    messageElem.classList.add('text-green-600');
				}
			} catch (e) {
				messageElem.textContent = `Error: ${e.message || e.toString()}`;
                messageElem.classList.add('text-red-600');
                messageElem.classList.remove('text-yellow-600', 'text-green-600');
				console.error("PNG Parsing Error:", e);
			}
		};

		reader.onerror = function() {
			messageElem.textContent = "File reading error";
            messageElem.classList.add('text-red-600');
            messageElem.classList.remove('text-yellow-600', 'text-green-600');
			console.error("File Reading Error:", reader.error);
		};

		messageElem.textContent = "Reading file...";
        messageElem.classList.remove('text-red-600', 'text-yellow-600', 'text-green-600');
		reader.readAsArrayBuffer(files[0]);
	};


	/*---- PNG parsing functions ----*/
	// (readPngChunks, PNG_SIGNATURE, computeCrc, updateCrc remain the same as previous version)
	function readPngChunks(bytes) {
		if (bytes.length < 8 || !bytes.subarray(0, 8).every((b, i) => (b === PNG_SIGNATURE[i])))
			throw new Error("Not a PNG file (invalid signature)");
		let chunks = [];
		let warnings = [];
		let index = 8;
		let foundIhdr = false, foundIdat = false, foundIend = false;
		while (index < bytes.length) {
			if (index + 8 > bytes.length) { warnings.push(`Offset ${index}: Unexpected end of file (chunk header truncated)`); break; }
			let length = readUint32(bytes, index + 0);
			let type = readAscii(bytes, index + 4, 4);
			if (length >= 0x80000000) { warnings.push(`Offset ${index}: Chunk type ${type} has unusually large length: ${length}.`); }
			if (!/^[A-Za-z]{4}$/.test(type)) {
                warnings.push(`Offset ${index}: Chunk type "${type}" has invalid characters. Attempting to skip.`);
                let skipToIndex = index + 8 + length + 4;
                if (skipToIndex <= bytes.length && skipToIndex > index) { index = skipToIndex; continue; }
                else { warnings.push(`Offset ${index}: Cannot safely skip corrupt chunk type "${type}". Stopping parse.`); break; }
            }
			let chunkEndIndex = index + 8 + length + 4;
			if (chunkEndIndex > bytes.length) { warnings.push(`Offset ${index}: Unexpected end of file (chunk data or CRC truncated for ${type})`); break; }
			let data = bytes.subarray(index + 8, index + 8 + length);
			let actualCrc = readUint32(bytes, index + 8 + length);
			let typeBytes = new Uint8Array(4); for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
			let expectedCrc = computeCrc(typeBytes, data);
			let crcOk = (actualCrc === expectedCrc);
			if (!crcOk) { warnings.push(`Chunk ${type} (offset ${index}): CRC mismatch! Expected ${formatHex(expectedCrc, 8)}, Got ${formatHex(actualCrc, 8)}`); console.warn(warnings[warnings.length-1]); }
			chunks.push({ type, length, data, offset: index, crc: actualCrc, crcOk });
            if (type === "IHDR") { if (chunks.length > 1) warnings.push("IHDR chunk is not the first chunk."); foundIhdr = true; }
            if (type === "IDAT") foundIdat = true;
            if (type === "IEND") { foundIend = true; if (chunkEndIndex < bytes.length) { warnings.push(`Data found after IEND chunk (offset ${chunkEndIndex}).`); } }
			index = chunkEndIndex;
		}
		if (!foundIhdr) throw new Error("Critical Error: Missing IHDR chunk.");
		if (!foundIdat) warnings.push("Warning: Missing IDAT chunk (no image data).");
        if (!foundIend && index >= bytes.length) warnings.push("Warning: Missing IEND chunk (file might be truncated).");
		return { chunks, warnings };
	}
	const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
	function computeCrc(typeBytes, dataBytes) { let crc = 0xFFFFFFFF; crc = updateCrc(crc, typeBytes); crc = updateCrc(crc, dataBytes); return crc ^ 0xFFFFFFFF; }
	let crcTable = null;
	function updateCrc(crc, bytes) { if (crcTable === null) { crcTable = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) { if ((c & 1) === 0) c = c >>> 1; else c = (c >>> 1) ^ 0xEDB88320; } crcTable[i] = c; } } for (const b of bytes) { crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8); } return crc; }


	/*---- Rendering functions ----*/

    // Renders the parsed chunks into individual styled boxes (2 columns)
    function renderChunkBoxes(chunks, warnings, ihdrInfo) {
        if (!chunkResultsContainer) { console.error("Cannot render: chunk results container not found."); return; }
        chunkResultsContainer.innerHTML = ''; // Clear previous results
		warnings.forEach(warning => console.warn("Parsing Warning:", warning));

		// Define the default placeholder text
        const defaultPlaceholderText = '— No displayable text content —';

		for (const chunk of chunks) {
            const chunkContainer = document.createElement('div');
            chunkContainer.className = 'chunk-container';
            if (!chunk.crcOk) { chunkContainer.classList.add('error-chunk'); }

            const grid = document.createElement('div');
            grid.className = 'chunk-grid'; // Now defaults to 1 col, becomes 2 on md+

            // --- Column 1: Chunk Details ---
            const infoCol = document.createElement('div');
            infoCol.className = 'chunk-info';
            // Display basic chunk info and CRC status
            infoCol.innerHTML = `
                <h3 class="chunk-title">Chunk Details</h3>
                <p><strong>Type:</strong> <span class="mono font-semibold text-blue-700">${escapeHtml(chunk.type)}</span></p>
                <p><strong>Offset:</strong> <span class="mono">${formatNumber(chunk.offset)}</span></p>
                <p><strong>Length:</strong> <span class="mono">${formatNumber(chunk.length)} bytes</span></p>
                <p><strong>CRC-32:</strong> <span class="mono">${formatHex(chunk.crc, 8)}</span>
                   <span class="${chunk.crcOk ? 'crc-ok' : 'crc-error'} ml-2">(${chunk.crcOk ? 'OK' : 'ERROR'})</span>
                </p>
                 <h3 class="chunk-title mt-4">Summary</h3>
                 <p>${getChunkSummaryText(chunk, ihdrInfo)}</p>
            `;
            grid.appendChild(infoCol);

            // --- Column 2: Text Content / Data ---
            const textCol = document.createElement('div');
            textCol.className = 'chunk-text-content';
            const textTitle = document.createElement('h3');
            textTitle.className = 'chunk-title';
            textTitle.textContent = 'Text Content / Data';
            textCol.appendChild(textTitle); // Always add the title

            let textContentElement = null; // Element to hold <pre> or <span>
            let hasActualContent = false; // Flag to check if we have real content

            try {
                // Check for specific text chunk types
                if (chunk.type === 'tEXt') {
                    let nul = chunk.data.indexOf(0);
                    if (nul !== -1) {
                        let text = readLatin1(chunk.data, nul + 1, chunk.length - (nul + 1));
                        textContentElement = document.createElement('pre');
                        textContentElement.className = 'text-content-pre';
                        textContentElement.textContent = text;
                        hasActualContent = true; // We have real text
                    } else {
                         textContentElement = createPlaceholderSpan('(Invalid tEXt format)');
                         hasActualContent = true; // Show the error message
                    }
                } else if (chunk.type === 'iTXt') {
                    let nul0 = chunk.data.indexOf(0);
                    if (nul0 !== -1 && nul0 + 3 <= chunk.length) {
                        let compFlag = chunk.data[nul0 + 1];
                        let nul1 = chunk.data.indexOf(0, nul0 + 3);
                        if (nul1 !== -1) {
                             let nul2 = chunk.data.indexOf(0, nul1 + 1);
                             if (nul2 !== -1) {
                                 if (compFlag === 0) { // Uncompressed
                                     let text = readUtf8(chunk.data, nul2 + 1, chunk.length - (nul2 + 1));
                                     textContentElement = document.createElement('pre');
                                     textContentElement.className = 'text-content-pre';
                                     textContentElement.textContent = text;
                                     hasActualContent = true; // We have real text
                                 } else {
                                     textContentElement = createPlaceholderSpan('(Compressed iTXt data)');
                                     hasActualContent = true; // Show the compression note
                                 }
                             } else { textContentElement = createPlaceholderSpan('(Invalid iTXt format)'); hasActualContent = true; }
                        } else { textContentElement = createPlaceholderSpan('(Invalid iTXt format)'); hasActualContent = true; }
                    } else { textContentElement = createPlaceholderSpan('(Invalid iTXt format)'); hasActualContent = true; }
                } else if (chunk.type === 'zTXt') {
                     let nul = chunk.data.indexOf(0);
                     if (nul !== -1 && nul + 2 <= chunk.length) {
                         textContentElement = createPlaceholderSpan('(Compressed zTXt data)');
                         hasActualContent = true; // Show the compression note
                     } else {
                         textContentElement = createPlaceholderSpan('(Invalid zTXt format)');
                         hasActualContent = true; // Show the error
                     }
                }
                // Add handling for other chunk types if needed, e.g., eXIf could be parsed

            } catch (e) {
                 // Handle errors during text processing
                 console.error(`Error processing text content for chunk ${chunk.type} at offset ${chunk.offset}:`, e);
                 textContentElement = createPlaceholderSpan(`(Error processing text: ${escapeHtml(e.message || e.toString())})`);
                 textContentElement.style.color = 'orange';
                 hasActualContent = true; // Show the error message
            }

            // Only append the text content element if it contains actual content/error
            if (hasActualContent) {
                textCol.appendChild(textContentElement);
            } else {
                 // Optionally add a minimal placeholder if you want the column title to always have something below it
                 // textCol.appendChild(createPlaceholderSpan(defaultPlaceholderText));
                 // Or leave it blank as per the request (textCol only contains the title)
            }
            grid.appendChild(textCol);


            chunkContainer.appendChild(grid);
            chunkResultsContainer.appendChild(chunkContainer);
		}
	}

    // Helper to create placeholder spans
    function createPlaceholderSpan(text) {
        const span = document.createElement('span');
        span.className = 'text-content-placeholder';
        span.textContent = text;
        return span;
    }

    // Helper function to parse IHDR data (used for context)
    function parseIhdrData(data) {
        if (data.length !== 13) throw "Invalid IHDR length for parsing";
        let width = readUint32(data, 0);
        let height = readUint32(data, 4);
        let bitDepth = data[8];
        let colorType = data[9];
        if (!isValidBitDepthColorType(bitDepth, colorType)) throw "Invalid bit depth/color type combination in IHDR";
        return { width, height, bitDepth, colorType };
    }

    // *** NEW HELPER: Gets summary text, handles errors ***
    function getChunkSummaryText(chunk, ihdrInfo) {
        try {
            return summarizeChunk(chunk, ihdrInfo); // Call the original summarize function
        } catch (e) {
            console.error(`Error summarizing chunk ${chunk.type} at offset ${chunk.offset}:`, e);
            // Return error message, ensuring it's escaped
            return `Error: ${escapeHtml(e.message || e.toString())}`;
        }
    }


	// Summarizes the data content of a chunk based on its type.
	// (summarizeChunk logic remains the same as previous version, but now called by getChunkSummaryText)
	function summarizeChunk(chunk, ihdrInfo) {
		let data = chunk.data;
		let length = chunk.length;
		switch (chunk.type) {
			case "IHDR": {
                const parsedIhdr = parseIhdrData(data);
				let colorTypeStr;
				switch (parsedIhdr.colorType) {
					case 0: colorTypeStr = "Grayscale"; break; case 2: colorTypeStr = "Truecolor (RGB)"; break;
					case 3: colorTypeStr = "Indexed-color"; break; case 4: colorTypeStr = "Grayscale + Alpha"; break;
					case 6: colorTypeStr = "Truecolor + Alpha (RGBA)"; break; default: colorTypeStr = "Invalid";
				}
                let compressionMethod = data[10], filterMethod = data[11], interlaceMethod = data[12];
				return `Dimensions: ${parsedIhdr.width} x ${parsedIhdr.height}, Bit Depth: ${parsedIhdr.bitDepth}, Color Type: ${parsedIhdr.colorType} (${colorTypeStr}), Compression: ${compressionMethod}, Filter: ${filterMethod}, Interlace: ${interlaceMethod}`;
			}
			case "PLTE": { if (length % 3 !== 0 || length > 256*3 || length === 0) throw "Invalid PLTE length"; return `Palette entries: ${length / 3}`; }
			case "IDAT": { return "Image data stream chunk"; }
			case "IEND": { if (length !== 0) throw "Invalid IEND length (must be 0)"; return "End of image stream marker"; }
			case "tRNS": {
                let details = "";
                if (ihdrInfo) {
                    switch (ihdrInfo.colorType) {
                        case 0: if (length !== 2) throw "Invalid tRNS length for grayscale (must be 2)"; details = `Single Gray Level=${readUint16(data, 0)}`; break;
                        case 2: if (length !== 6) throw "Invalid tRNS length for truecolor (must be 6)"; details = `Single RGB Color: R=${readUint16(data,0)}, G=${readUint16(data,2)}, B=${readUint16(data,4)}`; break;
                        case 3: if (length === 0 || length > 256) throw "Invalid tRNS length for indexed (must be 1-256)"; details = `${length} alpha entries for palette`; break;
                        default: throw "tRNS chunk is invalid for color types with an alpha channel (4 or 6)";
                    }
                } else { details = `(${length} bytes, requires IHDR context)`; }
				return `Transparency Data: ${details}`;
			}
			case "cHRM": {
				if (length !== 32) throw "Invalid cHRM length (must be 32)";
				let whiteX = readUint32(data, 0)/100000, whiteY=readUint32(data, 4)/100000, redX=readUint32(data, 8)/100000, redY=readUint32(data, 12)/100000;
                let greenX = readUint32(data, 16)/100000, greenY=readUint32(data, 20)/100000, blueX=readUint32(data, 24)/100000, blueY=readUint32(data, 28)/100000;
				return `Chromaticities: White(${whiteX.toFixed(4)},${whiteY.toFixed(4)}), R(${redX.toFixed(4)},${redY.toFixed(4)}), G(${greenX.toFixed(4)},${greenY.toFixed(4)}), B(${blueX.toFixed(4)},${blueY.toFixed(4)})`;
			}
			case "gAMA": { if (length !== 4) throw "Invalid gAMA length (must be 4)"; let gamma = readUint32(data, 0) / 100000; return `Image Gamma=${gamma.toFixed(5)}`; }
			case "iCCP": {
				let nul = data.indexOf(0); if (nul === -1 || nul > 79 || nul === 0) throw "Invalid iCCP profile name"; let name = readLatin1(data, 0, nul);
				if (nul + 2 > length) throw "Invalid iCCP data (missing compression method)"; let compMethod = data[nul + 1]; if (compMethod !== 0) throw "Invalid iCCP compression method";
				return `Embedded ICC Profile: Name="${escapeHtml(name)}", Compression Method=${compMethod}`;
			}
			case "sBIT": {
                let details = "";
                 if (ihdrInfo) {
                    switch (ihdrInfo.colorType) {
                        case 0: if (length !== 1) throw "Invalid sBIT length for grayscale"; details = `Gray=${data[0]}`; break;
                        case 2: if (length !== 3) throw "Invalid sBIT length for truecolor"; details = `R=${data[0]}, G=${data[1]}, B=${data[2]}`; break;
                        case 3: if (length !== 3) throw "Invalid sBIT length for indexed"; details = `Source Palette: R=${data[0]}, G=${data[1]}, B=${data[2]}`; break;
                        case 4: if (length !== 2) throw "Invalid sBIT length for grayscale+alpha"; details = `Gray=${data[0]}, Alpha=${data[1]}`; break;
                        case 6: if (length !== 4) throw "Invalid sBIT length for truecolor+alpha"; details = `R=${data[0]}, G=${data[1]}, B=${data[2]}, A=${data[3]}`; break;
                        default: details = "(Invalid color type)";
                    }
                 } else { details = `(${length} bytes, requires IHDR context)`; }
				return `Significant Bits: ${details}`;
			}
			case "sRGB": {
				if (length !== 1) throw "Invalid sRGB length (must be 1)"; let renderingIntent = data[0]; let intentStr;
				switch (renderingIntent) { case 0: intentStr = "Perceptual"; break; case 1: intentStr = "Relative colorimetric"; break; case 2: intentStr = "Saturation"; break; case 3: intentStr = "Absolute colorimetric"; break; default: throw "Invalid sRGB rendering intent"; }
				return `sRGB Rendering Intent: ${renderingIntent} (${intentStr})`;
			}
			case "iTXt": {
				let nul0 = data.indexOf(0); if (nul0 === -1 || nul0 > 79 || nul0 === 0) throw "Invalid iTXt keyword"; let keyword = readLatin1(data, 0, nul0);
				if (nul0 + 3 > length) throw "Invalid iTXt data (too short)"; let compFlag = data[nul0 + 1], compMethod = data[nul0 + 2];
				if (compFlag !== 0 && compFlag !== 1) throw "Invalid iTXt compression flag"; if (compFlag === 1 && compMethod !== 0) throw "Invalid iTXt compression method";
				let nul1 = data.indexOf(0, nul0 + 3); if (nul1 === -1) throw "Invalid iTXt data (missing lang tag terminator)"; let langTag = readLatin1(data, nul0 + 3, nul1 - (nul0 + 3));
				let nul2 = data.indexOf(0, nul1 + 1); if (nul2 === -1) throw "Invalid iTXt data (missing trans key terminator)"; let translatedKeyword = readUtf8(data, nul1 + 1, nul2 - (nul1 + 1));
				return `Intl Text: Key="${escapeHtml(keyword)}", Comp Flag=${compFlag}, Lang="${escapeHtml(langTag)}", Trans Key="${escapeHtml(translatedKeyword)}"`;
			}
			case "tEXt": { let nul = data.indexOf(0); if (nul === -1 || nul > 79 || nul === 0) throw "Invalid tEXt keyword"; let keyword = readLatin1(data, 0, nul); return `Textual Data: Key="${escapeHtml(keyword)}"`; }
			case "zTXt": { let nul = data.indexOf(0); if (nul === -1 || nul > 79 || nul === 0) throw "Invalid zTXt keyword"; let keyword = readLatin1(data, 0, nul); if (nul + 2 > length) throw "Invalid zTXt data (missing comp method)"; let compMethod = data[nul + 1]; if (compMethod !== 0) throw "Invalid zTXt compression method"; return `Compressed Text: Key="${escapeHtml(keyword)}", Method=${compMethod}`; }
			case "bKGD": {
                let details = "";
                 if (ihdrInfo) {
                    switch (ihdrInfo.colorType) {
                        case 0: case 4: if (length !== 2) throw "Invalid bKGD length for grayscale"; details = `Gray Level=${readUint16(data, 0)}`; break;
                        case 2: case 6: if (length !== 6) throw "Invalid bKGD length for truecolor"; details = `RGB Color: R=${readUint16(data,0)}, G=${readUint16(data,2)}, B=${readUint16(data,4)}`; break;
                        case 3: if (length !== 1) throw "Invalid bKGD length for indexed"; details = `Palette Index=${data[0]}`; break;
                        default: details = "(Invalid color type)";
                    }
                 } else { details = `(${length} bytes, requires IHDR context)`; }
				return `Background Color: ${details}`;
			}
			case "hIST": { if (length % 2 !== 0 || length === 0) throw "Invalid hIST length"; return `Palette Histogram: Entries=${length / 2}`; }
			case "pHYs": {
				if (length !== 9) throw "Invalid pHYs length"; let ppuX = readUint32(data, 0), ppuY = readUint32(data, 4), unitSpec = data[8]; let unitStr;
				if (unitSpec === 0) unitStr = "Unknown unit"; else if (unitSpec === 1) unitStr = "Pixels per metre"; else throw "Invalid pHYs unit specifier";
				return `Physical Dimensions: PPU X=${ppuX}, PPU Y=${ppuY}, Unit=${unitSpec} (${unitStr})`;
			}
			case "sPLT": {
				let nul = data.indexOf(0); if (nul === -1 || nul > 79 || nul === 0) throw "Invalid sPLT name"; let name = readLatin1(data, 0, nul); if (nul + 2 > length) throw "Invalid sPLT data (missing depth)"; let sampleDepth = data[nul + 1]; if (sampleDepth !== 8 && sampleDepth !== 16) throw "Invalid sPLT depth";
				let entrySize = (sampleDepth === 8 ? 6 : 10); let paletteDataLength = length - (nul + 1 + 1); if (paletteDataLength < 0 || paletteDataLength % entrySize !== 0) throw `Invalid sPLT data length for ${sampleDepth}-bit`; let numEntries = paletteDataLength / entrySize;
				return `Suggested Palette: Name="${escapeHtml(name)}", Depth=${sampleDepth}, Entries=${numEntries}`;
			}
			case "tIME": {
				if (length !== 7) throw "Invalid tIME length"; let year = readUint16(data, 0), month = data[2], day = data[3], hour = data[4], minute = data[5], second = data[6];
				if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) throw "Invalid tIME date/time value";
				return `Last Modified: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')} UTC`;
			}
            case "eXIf": { return `Exif Metadata chunk (${length} bytes)`; }
			case "acTL": { if (length !== 8) throw "Invalid acTL length"; let numFrames = readUint32(data, 0), numPlays = readUint32(data, 4); return `APNG Control: Frames=${numFrames}, Plays=${numPlays === 0 ? 'Infinite' : numPlays}`; }
			case "fcTL": {
				if (length !== 26) throw "Invalid fcTL length"; let sequenceNumber = readUint32(data, 0), width = readUint32(data, 4), height = readUint32(data, 8), xOffset = readUint32(data, 12), yOffset = readUint32(data, 16);
                let delayNum = readUint16(data, 20), delayDen = readUint16(data, 22), disposeOp = data[24], blendOp = data[25];
				if (width === 0 || height === 0) throw "Invalid fcTL: Zero frame dims"; let effectiveDelayDen = (delayDen === 0) ? 100 : delayDen; if (disposeOp > 2) throw "Invalid fcTL dispose op"; if (blendOp > 1) throw "Invalid fcTL blend op";
                let delay = (effectiveDelayDen === 0) ? "N/A" : (delayNum / effectiveDelayDen).toFixed(4) + "s"; const disposeMap = ["None", "Background", "Previous"]; const blendMap = ["Source", "Over"];
				return `APNG Frame Ctrl: Seq=${sequenceNumber}, Dim=${width}x${height}, Off=(${xOffset},${yOffset}), Delay=${delay}, Disp=${disposeMap[disposeOp] || 'Invalid'}, Blend=${blendMap[blendOp] || 'Invalid'}`;
			}
			case "fdAT": { if (length < 4) throw "Invalid fdAT length"; let sequenceNumber = readUint32(data, 0); return `APNG Frame Data: Seq=${sequenceNumber}`; }
			default: { if (/^[a-z]/.test(chunk.type.charAt(0))) return `Ancillary chunk ("${escapeHtml(chunk.type)}")`; else return `Critical chunk ("${escapeHtml(chunk.type)}")`; }
		}
	}

	// Checks if the bit depth and color type combination is valid according to PNG spec.
	function isValidBitDepthColorType(bitDepth, colorType) {
		const validCombinations = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
		return validCombinations[colorType]?.includes(bitDepth) ?? false;
	}


	/*---- Utilities ----*/
	function readUint16(bytes, offset) { if (offset + 2 > bytes.length) throw `Read past end (Uint16 @ ${offset})`; return (bytes[offset] << 8) | bytes[offset + 1]; }
	function readUint32(bytes, offset) { if (offset + 4 > bytes.length) throw `Read past end (Uint32 @ ${offset})`; return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0; }
	function readAscii(bytes, offset, len) { if (offset + len > bytes.length) throw `Read past end (ASCII @ ${offset}, len=${len})`; let r = ""; for (let i = 0; i < len; i++) { r += String.fromCharCode(bytes[offset + i]); } return r; }
	function readLatin1(bytes, offset, len) { if (offset + len > bytes.length) throw `Read past end (Latin1 @ ${offset}, len=${len})`; let r = ""; for (let i = 0; i < len; i++) { r += String.fromCharCode(bytes[offset + i]); } return r; }
	function readUtf8(bytes, offset, len) { if (offset + len > bytes.length) throw `Read past end (UTF8 @ ${offset}, len=${len})`; let s = bytes.subarray(offset, offset + len); try { return new TextDecoder("utf-8", { fatal: true }).decode(s); } catch (e) { throw `Invalid UTF-8 (offset ${offset}, len ${len}): ${e.message}`; } }
	function formatNumber(n) { if (typeof n !== 'number') return String(n); return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
	function formatHex(n, digits) { if (typeof n !== 'number') return String(n); return n.toString(16).toUpperCase().padStart(digits, "0"); }
    function escapeHtml(unsafe) { if (typeof unsafe !== 'string') return unsafe; return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

}; // End of app scope
