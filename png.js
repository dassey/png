/*
 * PNG file chunk inspector library (JavaScript)
 *
 * Copyright (c) 2022 Nayuki
 * All rights reserved. Contact Nayuki for licensing.
 * https://www.nayuki.io/page/png-file-chunk-inspector
 *
 * Modified to report CRC errors instead of throwing exceptions.
 */

"use strict";


var app = new function() {

	/*---- Fields ----*/

	// Get references to DOM elements once the DOM is loaded
	let fileElem = null;
	let analyzeButton = null;
	let messageElem = null;
	let chunkTable = null;
	let chunkTableBody = null;

	// Set of chunk types for which to display a hex/ASCII dump
	// Added more common types based on PNG spec and common usage
	const CHUNK_TYPES_TO_DUMP = new Set([
		"gAMA", "sRGB", "pHYs", "iTXt", "tEXt", "zTXt", "tIME",
		"cHRM", "iCCP", "sBIT", "cICP", "bKGD", "hIST", "sPLT",
		"eXIf" // Added eXIf as it often contains interesting metadata
	]);


	/*---- Initialization ----*/
	// Wait for the DOM to be fully loaded before accessing elements
	document.addEventListener('DOMContentLoaded', () => {
		fileElem = document.getElementById("input-file");
		analyzeButton = document.getElementById("analyze-button");
		messageElem = document.getElementById("message");
		chunkTable = document.getElementById("chunk-table");
		chunkTableBody = chunkTable.querySelector("tbody");

		// Ensure elements exist before attaching event listener
		if (analyzeButton) {
			analyzeButton.onclick = analyzeFile;
		} else {
			console.error("Analyze button not found!");
		}
        if (fileElem) {
             // Optional: Trigger analysis automatically when a file is selected
             // fileElem.onchange = analyzeFile;
        } else {
            console.error("File input element not found!");
        }
	});

	// Function to handle the analysis process
	function analyzeFile() {
		// Ensure elements are available
		if (!fileElem || !messageElem || !chunkTableBody || !chunkTable) {
			console.error("DOM elements not ready or not found.");
			if (messageElem) messageElem.textContent = "Initialization error. Please refresh.";
			return;
		}

		messageElem.textContent = ""; // Clear previous messages
		// Clear previous table content safely
		while (chunkTableBody.firstChild) {
			chunkTableBody.removeChild(chunkTableBody.firstChild);
		}
		chunkTable.classList.add("hidden"); // Hide table until results are ready

		let files = fileElem.files;
		if (!files || files.length < 1) {
			messageElem.textContent = "No file selected";
			return;
		}

		let reader = new FileReader();

		// Define what happens when the file is successfully read
		reader.onload = function() {
			try {
				let bytes = new Uint8Array(reader.result);
				let parseResult = readPngChunks(bytes); // Get chunks and potential warnings
				renderChunks(parseResult.chunks, parseResult.warnings); // Pass warnings to renderer
				if (parseResult.warnings.length > 0) {
					messageElem.textContent = "File parsed with warnings (see console and table).";
					messageElem.classList.remove('text-red-600'); // Use default text color or a warning color
					messageElem.classList.add('text-yellow-600');
				} else {
					messageElem.textContent = "File parsed successfully.";
					messageElem.classList.remove('text-red-600', 'text-yellow-600'); // Clear color classes
                    messageElem.classList.add('text-green-600'); // Use green for success
				}
			} catch (e) {
				// Handle critical parsing errors (e.g., not a PNG, missing essential chunks)
				messageElem.textContent = `Error: ${e.message || e.toString()}`;
                messageElem.classList.add('text-red-600'); // Ensure error color
                messageElem.classList.remove('text-yellow-600', 'text-green-600');
				console.error("PNG Parsing Error:", e);
			}
		};

		// Define what happens on file reading error
		reader.onerror = function() {
			messageElem.textContent = "File reading error";
            messageElem.classList.add('text-red-600');
            messageElem.classList.remove('text-yellow-600', 'text-green-600');
			console.error("File Reading Error:", reader.error);
		};

		// Start reading the file
		messageElem.textContent = "Reading file...";
        messageElem.classList.remove('text-red-600', 'text-yellow-600', 'text-green-600'); // Neutral color while reading
		reader.readAsArrayBuffer(files[0]);
	};


	/*---- PNG parsing functions ----*/

	// Takes the raw bytes of a PNG file, returns an object { chunks: [], warnings: [] },
	// throwing an exception only for critical errors.
	function readPngChunks(bytes) {
		// Check file signature
		if (bytes.length < 8 || !bytes.subarray(0, 8).every((b, i) => (b === PNG_SIGNATURE[i])))
			throw new Error("Not a PNG file (invalid signature)"); // Use Error object

		// Parse chunks
		let chunks = [];
		let warnings = []; // Store warnings like CRC errors
		let index = 8;
		let foundIhdr = false;
		let foundIdat = false;
		let foundIend = false;

		while (index < bytes.length) {
			// Check for sufficient bytes for chunk header
			if (index + 8 > bytes.length) {
				warnings.push(`Offset ${index}: Unexpected end of file (chunk header truncated)`);
				break; // Stop processing if header is incomplete
			}

			// Parse chunk header
			let length = readUint32(bytes, index + 0);
			if (length >= 0x80000000) {
                // This is technically allowed but practically problematic for memory. Warn instead of error.
				warnings.push(`Offset ${index}: Chunk length ${length} is unusually large.`);
                // Consider adding a check here to prevent allocating excessive memory if needed.
            }
			let type = readAscii(bytes, index + 4, 4);
			if (!/^[A-Za-z]{4}$/.test(type)) {
                // Invalid chunk type is serious, but maybe recoverable? Let's warn and try to skip.
                warnings.push(`Offset ${index}: Chunk type "${type}" has invalid characters. Skipping chunk.`);
                // We don't know the length for sure if the type is corrupt, but the length field might be valid.
                // Let's try to skip based on the read length, but be cautious.
                if (index + 8 + length + 4 <= bytes.length) {
                     index += 8 + length + 4;
                     continue; // Try next chunk
                } else {
                    warnings.push(`Offset ${index}: Cannot safely skip corrupt chunk due to potential length issue. Stopping parse.`);
                    break;
                }
            }


			// Check for sufficient bytes for chunk data and CRC
			if (index + 8 + length + 4 > bytes.length) {
				warnings.push(`Offset ${index}: Unexpected end of file (chunk data or CRC truncated for ${type})`);
				break; // Stop processing if chunk data/CRC is incomplete
			}

			// Parse chunk data
			let data = bytes.subarray(index + 8, index + 8 + length);

			// Parse and verify chunk CRC
			let actualCrc = readUint32(bytes, index + 8 + length);
			let typeBytes = new Uint8Array(4);
			for (let i = 0; i < 4; i++)
				typeBytes[i] = type.charCodeAt(i);
			let expectedCrc = computeCrc(typeBytes, data);
			let crcOk = (actualCrc === expectedCrc);

            // *** MODIFICATION START: Report CRC mismatch instead of throwing error ***
			if (!crcOk) {
				let warningMsg = `Chunk ${type} (offset ${index}): CRC mismatch! Expected ${formatHex(expectedCrc, 8)}, Got ${formatHex(actualCrc, 8)}`;
				warnings.push(warningMsg);
				console.warn(warningMsg);
                // Do not throw error, continue processing
			}
            // *** MODIFICATION END ***

			// Append chunk object
			chunks.push({
				type : type,
				length : length,
				data : data,
				offset : index,
                crc : actualCrc, // Store the actual CRC read from file
                crcOk: crcOk // Store the validation result
			});

            // Track essential chunks
            if (type === "IHDR") {
                if (chunks.length > 1) {
                    warnings.push("IHDR chunk is not the first chunk.");
                }
                foundIhdr = true;
            }
            if (type === "IDAT") foundIdat = true;
            if (type === "IEND") {
                foundIend = true;
                if (index + 8 + length + 4 < bytes.length) {
				    warnings.push("Data found after IEND chunk.");
                }
                // Optional: break here if you strictly want to ignore data after IEND
                // break;
            }

			index += 8 + length + 4; // Move index to the next chunk
		}

		// Check critical chunk presence after parsing all possible chunks
		if (!foundIhdr)
			throw new Error("Missing IHDR chunk"); // This is critical
		if (!foundIdat)
            warnings.push("Missing IDAT chunk (no image data)"); // Warn, maybe it's intentional?
        if (!foundIend && index >= bytes.length)
            warnings.push("Missing IEND chunk (file might be truncated)");


		return { chunks: chunks, warnings: warnings };
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
		// Initialize table only once
		if (crcTable === null) {
			crcTable = new Int32Array(256);
			for (let i = 0; i < 256; i++) {
				let c = i;
				for (let j = 0; j < 8; j++) {
					if ((c & 1) === 0)
						c = c >>> 1;
					else
						c = (c >>> 1) ^ 0xEDB88320; // Standard CRC-32 polynomial
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

	// Renders the given list of chunk objects into the page DOM.
	function renderChunks(chunks, warnings) {
		chunkTable.classList.remove("hidden");

		// Log all warnings collected during parsing
		warnings.forEach(warning => console.warn("Parsing Warning:", warning));

		// Get table header info for mapping data keys to cells
		let headers = chunkTable.querySelector("thead tr").cells;
		let colInfos = [];
		for (let i = 0; i < headers.length; i++) {
			colInfos.push({
				name: headers[i].dataset.key, // Get the key from data-key attribute
				isRight: headers[i].classList.contains("text-right")
			});
		}

		// Iterate through each chunk and create a table row
		for (const chunk of chunks) {
			let row = chunkTableBody.insertRow();
            if (!chunk.crcOk) {
                row.style.backgroundColor = "#fffbeb"; // Light yellow background for rows with CRC errors
            }

			// Create cells based on header info
			let cells = {};
			for (const info of colInfos) {
				let cell = row.insertCell();
				// Basic Tailwind-like styling (applied via <style> in HTML)
				if (info.isRight) {
					cell.classList.add("text-right");
				}
				cells[info.name] = cell; // Store cell reference by key
			}

			// Populate cells with chunk data
			cells.offset.textContent = formatNumber(chunk.offset);
			cells.length.textContent = formatNumber(chunk.length);
			cells.type.textContent = chunk.type;
			cells.crc.textContent = formatHex(chunk.crc, 8); // Show the CRC read from the file

			// Get chunk summary
			let summary = "";
			try {
				summary = summarizeChunk(chunk); // Summarize based on chunk type
			} catch (e) {
				console.error(`Error summarizing chunk ${chunk.type} at offset ${chunk.offset}:`, e);
				summary = `Error summarizing: ${e.message || e.toString()}`;
			}

            // *** MODIFICATION START: Add CRC status to summary ***
            if (!chunk.crcOk) {
                summary += (summary ? "; " : "") + "CRC ERROR!"; // Append CRC error notice
                cells.crc.style.color = "red"; // Highlight the incorrect CRC value
                cells.crc.style.fontWeight = "bold";
            }
            // *** MODIFICATION END ***
			cells.summary.textContent = summary;


			// Display data dump if the chunk type is in the set
			if (CHUNK_TYPES_TO_DUMP.has(chunk.type)) {
				const dumpContent = dumpChunkData(chunk.data);
				// Use <pre> for better formatting of the dump
				const pre = document.createElement('pre');
				pre.textContent = dumpContent;
				cells.dump.appendChild(pre);
			} else {
				 cells.dump.textContent = '—'; // Indicate no dump for this type
			}
		}
	}


	// Summarizes the data content of a chunk based on its type.
	// Throws an error string if the format is invalid.
	function summarizeChunk(chunk) {
		let data = chunk.data;
		let length = chunk.length;
		switch (chunk.type) {
			case "IHDR": {
				if (length !== 13) throw "Invalid IHDR length";
				let width = readUint32(data, 0);
				let height = readUint32(data, 4);
				let bitDepth = data[8];
				let colorType = data[9];
				let compressionMethod = data[10];
				let filterMethod = data[11];
				let interlaceMethod = data[12];
				if (width === 0 || height === 0) throw "Zero width or height";
				if (!isValidBitDepthColorType(bitDepth, colorType)) throw "Invalid bit depth/color type combination";
				if (compressionMethod !== 0) throw "Invalid compression method";
				if (filterMethod !== 0) throw "Invalid filter method";
				if (interlaceMethod !== 0 && interlaceMethod !== 1) throw "Invalid interlace method";
				let colorTypeStr;
				switch (colorType) {
					case 0: colorTypeStr = "Grayscale"; break;
					case 2: colorTypeStr = "Truecolor"; break;
					case 3: colorTypeStr = "Indexed-color"; break;
					case 4: colorTypeStr = "Grayscale+alpha"; break;
					case 6: colorTypeStr = "Truecolor+alpha"; break;
					default: colorTypeStr = "Invalid"; // Should be caught by isValidBitDepthColorType
				}
				return `W=${width}, H=${height}, Depth=${bitDepth}, Type=${colorType} (${colorTypeStr}), Comp=${compressionMethod}, Filter=${filterMethod}, Lace=${interlaceMethod}`;
			}
			case "PLTE": {
				if (length % 3 !== 0 || length > 256*3 || length === 0) throw "Invalid PLTE length";
				return `Palette entries=${length / 3}`;
			}
			case "IDAT": {
				return "Image data"; // Simple summary
			}
			case "IEND": {
				if (length !== 0) throw "Invalid IEND length";
				return "End of image";
			}
			case "tRNS": {
				// Validity depends on IHDR color type, but basic length check possible
                // Needs context from IHDR chunk to fully validate. For now, just report length.
				return `Transparency data (${length} bytes)`;
			}
			case "cHRM": {
				if (length !== 32) throw "Invalid cHRM length";
				let whiteX = readUint32(data, 0) / 100000;
				let whiteY = readUint32(data, 4) / 100000;
				let redX = readUint32(data, 8) / 100000;
				let redY = readUint32(data, 12) / 100000;
				let greenX = readUint32(data, 16) / 100000;
				let greenY = readUint32(data, 20) / 100000;
				let blueX = readUint32(data, 24) / 100000;
				let blueY = readUint32(data, 28) / 100000;
				// Format numbers to reasonable precision
				return `White(${whiteX.toFixed(5)},${whiteY.toFixed(5)}), R(${redX.toFixed(5)},${redY.toFixed(5)}), G(${greenX.toFixed(5)},${greenY.toFixed(5)}), B(${blueX.toFixed(5)},${blueY.toFixed(5)})`;
			}
			case "gAMA": {
				if (length !== 4) throw "Invalid gAMA length";
				let gamma = readUint32(data, 0) / 100000;
				return `Gamma=${gamma.toFixed(5)}`;
			}
			case "iCCP": {
				let nul = data.indexOf(0);
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid profile name";
				let name = readLatin1(data, 0, nul);
				if (nul + 2 > length) throw "Missing compression method"; // Need at least 1 byte for name, null, 1 byte method
				let compMethod = data[nul + 1];
				if (compMethod !== 0) throw "Invalid compression method (only 0 allowed)";
				return `Profile name="${name}", Comp method=${compMethod}`;
			}
			case "sBIT": {
				// Validity depends on IHDR color type. Just report length.
				return `Significant bits (${length} bytes)`;
			}
			case "sRGB": {
				if (length !== 1) throw "Invalid sRGB length";
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
			case "cICP": { // Introduced in PNG 3rd Edition
				if (length !== 4) throw "Invalid cICP length";
				let colorPrimaries = data[0];
				let transferCharacteristics = data[1];
				let matrixCoefficients = data[2];
				let videoFullRangeFlag = data[3];
				if (videoFullRangeFlag > 1) throw "Invalid video full range flag";
				return `Primaries=${colorPrimaries}, Transfer=${transferCharacteristics}, Matrix=${matrixCoefficients}, Full range=${videoFullRangeFlag}`;
			}
			case "iTXt": {
				let nul0 = data.indexOf(0); // End of keyword
				if (nul0 === -1 || nul0 > 79 || nul0 === 0) throw "Invalid keyword";
				let keyword = readLatin1(data, 0, nul0);
				if (nul0 + 3 > length) throw "Data too short (missing flags/tags)"; // Need keyword, null, comp flag, comp method, null for lang tag
				let compFlag = data[nul0 + 1];
				let compMethod = data[nul0 + 2];
				if (compFlag !== 0 && compFlag !== 1) throw "Invalid compression flag";
				if (compFlag === 1 && compMethod !== 0) throw "Invalid compression method for compressed text";
				let nul1 = data.indexOf(0, nul0 + 3); // End of language tag
				if (nul1 === -1) throw "Missing language tag terminator";
				let langTag = readLatin1(data, nul0 + 3, nul1 - (nul0 + 3));
				let nul2 = data.indexOf(0, nul1 + 1); // End of translated keyword
				if (nul2 === -1) throw "Missing translated keyword terminator";
				let translatedKeyword = readUtf8(data, nul1 + 1, nul2 - (nul1 + 1));
				// let text = readUtf8(data.subarray(nul2 + 1)); // Actual text requires decompression if compFlag=1
				return `Keyword="${keyword}", Comp=${compFlag}, Method=${compMethod}, Lang="${langTag}", Trans Key="${translatedKeyword}"`;
			}
			case "tEXt": {
				let nul = data.indexOf(0);
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid keyword";
				let keyword = readLatin1(data, 0, nul);
				let text = readLatin1(data, nul + 1, length - (nul + 1));
				// Limit displayed text length for brevity
                let textPreview = text.length > 60 ? text.substring(0, 57) + "..." : text;
				return `Keyword="${keyword}", Text="${textPreview}"`;
			}
			case "zTXt": {
				let nul = data.indexOf(0);
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid keyword";
				let keyword = readLatin1(data, 0, nul);
				if (nul + 2 > length) throw "Data too short (missing compression method)";
				let compMethod = data[nul + 1];
				if (compMethod !== 0) throw "Invalid compression method (only 0 allowed)";
				// let compressedText = data.subarray(nul + 2); // Requires decompression
				return `Keyword="${keyword}", Comp method=${compMethod}`;
			}
			case "bKGD": {
				// Validity depends on IHDR color type. Just report length.
				return `Background color (${length} bytes)`;
			}
			case "hIST": {
				// Validity depends on PLTE having been seen.
				if (length % 2 !== 0 || length === 0) throw "Invalid hIST length";
				return `Histogram entries=${length / 2}`;
			}
			case "pHYs": {
				if (length !== 9) throw "Invalid pHYs length";
				let ppuX = readUint32(data, 0);
				let ppuY = readUint32(data, 4);
				let unitSpec = data[8];
				let unitStr;
				if (unitSpec === 0) unitStr = "Unknown";
				else if (unitSpec === 1) unitStr = "Metre";
				else throw "Invalid unit specifier";
				return `PPU X=${ppuX}, PPU Y=${ppuY}, Unit=${unitSpec} (${unitStr})`;
			}
			case "sPLT": {
				let nul = data.indexOf(0);
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid palette name";
				let name = readLatin1(data, 0, nul);
				if (nul + 2 > length) throw "Data too short (missing sample depth)";
				let sampleDepth = data[nul + 1];
				if (sampleDepth !== 8 && sampleDepth !== 16) throw "Invalid sample depth";
				let entrySize = (sampleDepth === 8 ? 6 : 10); // R,G,B,A (1 or 2 bytes each) + Freq (2 bytes)
                let dataLength = length - (nul + 1 + 1);
				if (dataLength % entrySize !== 0) throw `Invalid data length for ${sampleDepth}-bit entries`;
				let numEntries = dataLength / entrySize;
				return `Palette name="${name}", Depth=${sampleDepth}, Entries=${numEntries}`;
			}
			case "eXIf": { // From Exif standard, not PNG spec directly
				return `Exif data (${length} bytes)`;
			}
			case "tIME": {
				if (length !== 7) throw "Invalid tIME length";
				let year = readUint16(data, 0);
				let month = data[2];
				let day = data[3];
				let hour = data[4];
				let minute = data[5];
				let second = data[6];
				if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) // second can be 60 for leap second
					throw "Invalid date/time value";
				// Format nicely with padding
				return `Last modified: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;
			}
			// APNG Chunks
			case "acTL": { // Animation Control
				if (length !== 8) throw "Invalid acTL length";
				let numFrames = readUint32(data, 0);
				let numPlays = readUint32(data, 4);
				return `Frames=${numFrames}, Plays=${numPlays === 0 ? 'Infinite' : numPlays}`;
			}
			case "fcTL": { // Frame Control
				if (length !== 26) throw "Invalid fcTL length";
				let sequenceNumber = readUint32(data, 0);
				let width = readUint32(data, 4);
				let height = readUint32(data, 8);
				let xOffset = readUint32(data, 12);
				let yOffset = readUint32(data, 16);
				let delayNum = readUint16(data, 20);
				let delayDen = readUint16(data, 22);
				let disposeOp = data[24];
				let blendOp = data[25];
				if (width === 0 || height === 0) throw "Zero frame width or height";
                if (delayDen === 0) delayDen = 100; // Default denominator is 100 if 0
				if (disposeOp > 2) throw "Invalid dispose operation";
				if (blendOp > 1) throw "Invalid blend operation";
                let delay = delayDen === 0 ? "N/A" : (delayNum / delayDen).toFixed(4) + "s";
				return `Seq=${sequenceNumber}, Dim=${width}x${height}, Off=(${xOffset},${yOffset}), Delay=${delay}, Disp=${disposeOp}, Blend=${blendOp}`;
			}
			case "fdAT": { // Frame Data
				if (length < 4) throw "Invalid fdAT length";
				let sequenceNumber = readUint32(data, 0);
				return `Frame data seq=${sequenceNumber}`;
			}
			// Unknown Chunks
			default: {
				if (/^[a-z]/.test(chunk.type.charAt(0))) // First char determines critical/ancillary
					return "Ancillary chunk (Unknown)";
				else
					return "Critical chunk (Unknown)";
			}
		}
	}


	// Checks if the bit depth and color type combination is valid according to PNG spec.
	function isValidBitDepthColorType(bitDepth, colorType) {
		const validCombinations = {
			0: [1, 2, 4, 8, 16], // Grayscale
			2: [8, 16],         // Truecolor
			3: [1, 2, 4, 8],    // Indexed-color
			4: [8, 16],         // Grayscale with alpha
			6: [8, 16]          // Truecolor with alpha
		};
		return validCombinations[colorType]?.includes(bitDepth) ?? false;
	}


	// Dumps chunk data as hex and printable ASCII.
	function dumpChunkData(data) {
		const BYTES_PER_LINE = 16;
		let s = "";
		for (let i = 0; i < data.length; i += BYTES_PER_LINE) {
			let slice = data.subarray(i, Math.min(i + BYTES_PER_LINE, data.length));
			// Hex part
			for (let j = 0; j < BYTES_PER_LINE; j++) {
                if (j < slice.length)
				    s += formatHex(slice[j], 2) + " ";
                else
                    s += "   "; // Pad if line is short
                if (j === 7) s += " "; // Extra space in the middle
			}
			s += " |";
			// ASCII part
			for (let j = 0; j < slice.length; j++) {
				let c = slice[j];
				if (0x20 <= c && c <= 0x7E) // Printable ASCII range
					s += String.fromCharCode(c);
				else
					s += "."; // Placeholder for non-printable
			}
            s += "|\n"; // Add closing pipe and newline
		}
		return s.replace(/\n$/, ""); // Remove trailing newline
	}


	/*---- Utilities ----*/

	// Reads a 16-bit unsigned integer (big-endian) from byte array.
	function readUint16(bytes, offset) {
        if (offset + 2 > bytes.length) throw "Read past end of buffer (Uint16)";
		return (bytes[offset] << 8) | bytes[offset + 1];
	}

	// Reads a 32-bit unsigned integer (big-endian) from byte array.
	function readUint32(bytes, offset) {
        if (offset + 4 > bytes.length) throw "Read past end of buffer (Uint32)";
		// Use bit shifts and unsigned right shift (>>> 0) for correct positive result
		return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
	}

	// Reads ASCII string (1 byte per char) from byte array.
	function readAscii(bytes, offset, len) {
        if (offset + len > bytes.length) throw `Read past end of buffer (ASCII: len=${len})`;
		let result = "";
		for (let i = 0; i < len; i++) {
            let charCode = bytes[offset + i];
            // Basic ASCII validation (optional but good practice)
            // if (charCode > 127) console.warn(`Non-ASCII char code ${charCode} found in ASCII string`);
			result += String.fromCharCode(charCode);
        }
		return result;
	}

	// Reads Latin-1 string (1 byte per char) from byte array.
	function readLatin1(bytes, offset, len) {
        // For JavaScript, Latin-1 (ISO-8859-1) reading is often the same as ASCII
        // if character codes are treated directly.
		return readAscii(bytes, offset, len);
	}

	// Reads UTF-8 string from byte array. Throws error on invalid UTF-8 sequence.
	function readUtf8(bytes, offset, len) {
        if (offset + len > bytes.length) throw `Read past end of buffer (UTF8: len=${len})`;
        let subarray = bytes.subarray(offset, offset + len);
		try {
            // Use TextDecoder for robust UTF-8 decoding
		    return new TextDecoder("utf-8", { fatal: true }).decode(subarray);
        } catch (e) {
            // Provide more context on error
            throw `Invalid UTF-8 sequence found (offset ${offset}, length ${len}): ${e.message}`;
        }
	}

	// Formats a number with thousands separators.
	function formatNumber(n) {
        if (typeof n !== 'number') return String(n);
		return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	}

	// Formats a number as uppercase hexadecimal string, padded with zeros.
	function formatHex(n, digits) {
        if (typeof n !== 'number') return String(n);
		return n.toString(16).toUpperCase().padStart(digits, "0");
	}

}; // End of app scope
