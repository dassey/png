/*
 * PNG file chunk inspector library (JavaScript)
 *
 * Copyright (c) 2022 Nayuki
 * All rights reserved. Contact Nayuki for licensing.
 * https://www.nayuki.io/page/png-file-chunk-inspector
 *
 * Modified to report CRC errors instead of throwing exceptions.
 * Modified to display decoded text for tEXt/iTXt chunks.
 * Modified to render chunks in separate boxes instead of table rows.
 */

"use strict";


var app = new function() {

	/*---- Fields ----*/
	let fileElem = null;
	let analyzeButton = null;
	let messageElem = null;
	// *** MODIFICATION: Reference the new container div ***
	let chunkResultsContainer = null;


	/*---- Initialization ----*/
	document.addEventListener('DOMContentLoaded', () => {
		fileElem = document.getElementById("input-file");
		analyzeButton = document.getElementById("analyze-button");
		messageElem = document.getElementById("message");
		// *** MODIFICATION: Get the new container ***
		chunkResultsContainer = document.getElementById("chunk-results-container");

		// Check if essential elements were found
		if (!analyzeButton) {
			console.error("Analyze button ('analyze-button') not found!");
            if(messageElem) messageElem.textContent = "Page Error: Analyze button missing.";
            return; // Stop initialization if button is missing
		}
        if (!chunkResultsContainer) {
            console.error("Results container ('chunk-results-container') not found!");
            if(messageElem) messageElem.textContent = "Page Error: Results container missing.";
            return; // Stop initialization if container is missing
        }
        if (!fileElem) {
            console.error("File input element ('input-file') not found!");
             // Allow continuing, but file selection won't work
        }
        if (!messageElem) {
             console.error("Message element ('message') not found!");
             // Allow continuing, but messages won't display
        }


		// Attach event listener if button exists
		analyzeButton.onclick = analyzeFile;

        // Optional: Trigger analysis on file change if input exists
        if (fileElem) {
             // fileElem.onchange = analyzeFile;
        }
	});

	// Function to handle the analysis process
	function analyzeFile() {
		// Double-check elements needed for analysis are available
		if (!fileElem || !messageElem || !chunkResultsContainer) {
			console.error("DOM elements not ready or not found for analysis.");
			if (messageElem) messageElem.textContent = "Runtime Error: Page elements missing. Please refresh.";
			return;
		}

		messageElem.textContent = ""; // Clear previous messages
		// Clear the results container
		chunkResultsContainer.innerHTML = ''; // Clear previous boxes

		let files = fileElem.files;
		if (!files || files.length < 1) {
			messageElem.textContent = "No file selected";
			return;
		}

		let reader = new FileReader();

		// Define actions on successful file read
		reader.onload = function() {
			try {
				let bytes = new Uint8Array(reader.result);
                let ihdrInfo = null; // To store context from IHDR
				let parseResult = readPngChunks(bytes); // Parse the file

                 // Attempt to get IHDR context for other chunks
                 const ihdrChunk = parseResult.chunks.find(c => c.type === 'IHDR');
                 if (ihdrChunk) {
                     try {
                         ihdrInfo = parseIhdrData(ihdrChunk.data);
                     } catch (e) {
                         console.error("Could not parse IHDR data for context:", e);
                         parseResult.warnings.push("Failed to parse IHDR data for context.");
                     }
                 }

                // Render the results using the new boxed layout function
				renderChunkBoxes(parseResult.chunks, parseResult.warnings, ihdrInfo);

                // Update status message based on warnings
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
                // Handle critical parsing errors
				messageElem.textContent = `Error: ${e.message || e.toString()}`;
                messageElem.classList.add('text-red-600');
                messageElem.classList.remove('text-yellow-600', 'text-green-600');
				console.error("PNG Parsing Error:", e);
			}
		};

		// Define action on file reading error
		reader.onerror = function() {
			messageElem.textContent = "File reading error";
            messageElem.classList.add('text-red-600');
            messageElem.classList.remove('text-yellow-600', 'text-green-600');
			console.error("File Reading Error:", reader.error);
		};

		// Start reading the selected file
		messageElem.textContent = "Reading file...";
        messageElem.classList.remove('text-red-600', 'text-yellow-600', 'text-green-600'); // Neutral color
		reader.readAsArrayBuffer(files[0]);
	};


	/*---- PNG parsing functions ----*/
	// Takes the raw bytes of a PNG file, returns an object { chunks: [], warnings: [] },
	// throwing an exception only for critical errors like invalid signature or missing IHDR.
	function readPngChunks(bytes) {
		// 1. Check PNG signature (8 bytes)
		if (bytes.length < 8 || !bytes.subarray(0, 8).every((b, i) => (b === PNG_SIGNATURE[i])))
			throw new Error("Not a PNG file (invalid signature)");

		// Initialize results and tracking variables
		let chunks = [];
		let warnings = [];
		let index = 8; // Start reading after the signature
		let foundIhdr = false;
		let foundIdat = false;
		let foundIend = false;

		// 2. Loop through chunks until end of file or critical error
		while (index < bytes.length) {
			// Check if there are enough bytes for chunk header (length + type = 8 bytes)
			if (index + 8 > bytes.length) {
				warnings.push(`Offset ${index}: Unexpected end of file (chunk header truncated)`);
				break; // Cannot continue without a full header
			}

			// 3. Read chunk length and type
			let length = readUint32(bytes, index + 0); // 4 bytes for length
			let type = readAscii(bytes, index + 4, 4); // 4 bytes for type

            // Validate chunk length (optional, but good practice for huge files)
			if (length >= 0x80000000) { // Check against 2^31 (practical limit)
				warnings.push(`Offset ${index}: Chunk type ${type} has unusually large length: ${length}.`);
            }

            // Validate chunk type format (must be 4 ASCII letters)
			if (!/^[A-Za-z]{4}$/.test(type)) {
                warnings.push(`Offset ${index}: Chunk type "${type}" has invalid characters. Attempting to skip.`);
                // Try to skip based on the potentially corrupted length field. Risky.
                let skipToIndex = index + 8 + length + 4;
                if (skipToIndex <= bytes.length && skipToIndex > index) { // Basic sanity check on skip index
                     index = skipToIndex;
                     continue; // Try the next chunk
                } else {
                    warnings.push(`Offset ${index}: Cannot safely skip corrupt chunk type "${type}" due to invalid length/EOF. Stopping parse.`);
                    break; // Stop parsing if skip is impossible
                }
            }

			// 4. Check if there are enough bytes for chunk data and CRC
			let chunkEndIndex = index + 8 + length + 4;
			if (chunkEndIndex > bytes.length) {
				warnings.push(`Offset ${index}: Unexpected end of file (chunk data or CRC truncated for ${type})`);
				break; // Cannot continue without full chunk data + CRC
			}

			// 5. Extract chunk data
			let data = bytes.subarray(index + 8, index + 8 + length);

			// 6. Read and verify chunk CRC
			let actualCrc = readUint32(bytes, index + 8 + length); // Read CRC from file
			let typeBytes = new Uint8Array(4); // Convert type string to bytes for CRC calc
			for (let i = 0; i < 4; i++)
				typeBytes[i] = type.charCodeAt(i);
			let expectedCrc = computeCrc(typeBytes, data); // Calculate expected CRC
			let crcOk = (actualCrc === expectedCrc); // Compare

			// Add warning if CRC mismatch, but don't stop parsing
			if (!crcOk) {
				let warningMsg = `Chunk ${type} (offset ${index}): CRC mismatch! Expected ${formatHex(expectedCrc, 8)}, Got ${formatHex(actualCrc, 8)}`;
				warnings.push(warningMsg);
				console.warn(warningMsg);
			}

			// 7. Store chunk information
			chunks.push({
				type : type,
				length : length,
				data : data,
				offset : index,
                crc : actualCrc, // Store the actual CRC read
                crcOk: crcOk    // Store the validation result
			});

            // 8. Track essential chunks and potential issues
            if (type === "IHDR") {
                if (chunks.length > 1) warnings.push("IHDR chunk is not the first chunk.");
                foundIhdr = true;
            }
            if (type === "IDAT") foundIdat = true;
            if (type === "IEND") {
                foundIend = true;
                if (chunkEndIndex < bytes.length) { // Check if there's data *after* IEND
				    warnings.push(`Data found after IEND chunk (offset ${chunkEndIndex}).`);
                }
                // Optional: break here if strictly adhering to spec (nothing after IEND)
                // break;
            }

			// 9. Move index to the start of the next chunk
			index = chunkEndIndex;
		}

		// 10. Final checks after loop finishes
		if (!foundIhdr)
			throw new Error("Critical Error: Missing IHDR chunk."); // File is invalid without IHDR
		if (!foundIdat)
            warnings.push("Warning: Missing IDAT chunk (no image data)."); // Valid but unusual
        if (!foundIend && index >= bytes.length) // Only warn if loop finished normally without IEND
            warnings.push("Warning: Missing IEND chunk (file might be truncated).");


		return { chunks: chunks, warnings: warnings }; // Return parsed chunks and any warnings
	}

	// PNG file signature constant
	const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

	// Computes the CRC-32 of the given byte sequences (type + data).
	function computeCrc(typeBytes, dataBytes) {
		let crc = 0xFFFFFFFF; // Initial value
		crc = updateCrc(crc, typeBytes); // Update with type bytes
		crc = updateCrc(crc, dataBytes); // Update with data bytes
		return crc ^ 0xFFFFFFFF; // Final XOR
	}

	// CRC table (lazily initialized)
	let crcTable = null;
	// Updates the CRC-32 value with the given sequence of bytes.
	function updateCrc(crc, bytes) {
		// Initialize CRC table if it hasn't been done yet
		if (crcTable === null) {
			crcTable = new Int32Array(256);
			for (let i = 0; i < 256; i++) {
				let c = i;
				for (let j = 0; j < 8; j++) { // Process 8 bits
					if ((c & 1) === 0) // If LSB is 0
						c = c >>> 1;    // Shift right
					else                // If LSB is 1
						c = (c >>> 1) ^ 0xEDB88320; // Shift right and XOR with polynomial
				}
				crcTable[i] = c;
			}
		}
		// Compute CRC using the table
		for (const b of bytes) {
			crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
		}
		return crc;
	}


	/*---- Rendering functions ----*/

    // Renders the parsed chunks into individual styled boxes in the results container.
    function renderChunkBoxes(chunks, warnings, ihdrInfo) {
        // Ensure the container exists and is cleared
        if (!chunkResultsContainer) {
            console.error("Cannot render: chunk results container not found.");
            return;
        }
        chunkResultsContainer.innerHTML = ''; // Clear previous results

		// Log any parsing warnings to the console
		warnings.forEach(warning => console.warn("Parsing Warning:", warning));

		// Iterate through each parsed chunk and create a display box
		for (const chunk of chunks) {
            // 1. Create main container div for the chunk
            const chunkContainer = document.createElement('div');
            chunkContainer.className = 'chunk-container'; // Apply base styling
            if (!chunk.crcOk) {
                chunkContainer.classList.add('error-chunk'); // Add error highlight style
            }

            // 2. Create the inner grid for columns
            const grid = document.createElement('div');
            grid.className = 'chunk-grid';

            // --- Column 1: Chunk Details ---
            const infoCol = document.createElement('div');
            infoCol.className = 'chunk-info'; // For potential border/padding
            // Use innerHTML for easier formatting with spans and classes
            infoCol.innerHTML = `
                <h3 class="chunk-title">Chunk Details</h3>
                <p><strong>Type:</strong> <span class="mono font-semibold text-blue-700">${escapeHtml(chunk.type)}</span></p>
                <p><strong>Offset:</strong> <span class="mono">${formatNumber(chunk.offset)}</span></p>
                <p><strong>Length:</strong> <span class="mono">${formatNumber(chunk.length)} bytes</span></p>
                <p><strong>CRC-32:</strong> <span class="mono">${formatHex(chunk.crc, 8)}</span>
                   <span class="${chunk.crcOk ? 'crc-ok' : 'crc-error'} ml-2">(${chunk.crcOk ? 'OK' : 'ERROR'})</span>
                </p>
            `;
            grid.appendChild(infoCol);

            // --- Column 2: Summary ---
            const summaryCol = document.createElement('div');
            summaryCol.className = 'chunk-summary'; // For potential border/padding
            const summaryTitle = document.createElement('h3');
            summaryTitle.className = 'chunk-title';
            summaryTitle.textContent = 'Summary';
            summaryCol.appendChild(summaryTitle);

            const summaryP = document.createElement('p'); // Paragraph for the summary text
			try {
                // Get summary text, passing IHDR context if available
				summaryP.textContent = summarizeChunk(chunk, ihdrInfo);
			} catch (e) {
                // Display error if summarization fails
				console.error(`Error summarizing chunk ${chunk.type} at offset ${chunk.offset}:`, e);
				summaryP.textContent = `Error summarizing: ${escapeHtml(e.message || e.toString())}`;
                summaryP.style.color = 'orange'; // Indicate error visually
			}
            summaryCol.appendChild(summaryP);
            grid.appendChild(summaryCol);

            // --- Column 3: Text Content / Data Placeholder ---
            const textCol = document.createElement('div');
            textCol.className = 'chunk-text-content'; // Container for text/placeholder
            const textTitle = document.createElement('h3');
            textTitle.className = 'chunk-title';
            textTitle.textContent = 'Text Content / Data';
            textCol.appendChild(textTitle);

            let textContentElement = null; // This will hold the <pre> or placeholder <span>

            try {
                let textFound = false; // Flag to track if we generated specific content for this column
                // Handle tEXt chunks
                if (chunk.type === 'tEXt') {
                    let nul = chunk.data.indexOf(0); // Find null terminator for keyword
                    if (nul !== -1) {
                        // Decode text (Latin1) after the keyword and null terminator
                        let text = readLatin1(chunk.data, nul + 1, chunk.length - (nul + 1));
                        textContentElement = document.createElement('pre'); // Use <pre> for formatting
                        textContentElement.className = 'text-content-pre';
                        textContentElement.textContent = text; // Display decoded text
                        textFound = true;
                    } else {
                         // Invalid format, show placeholder error
                         textContentElement = createPlaceholderSpan('(Invalid tEXt format: missing keyword terminator)');
                         textFound = true;
                    }
                // Handle iTXt chunks
                } else if (chunk.type === 'iTXt') {
                    let nul0 = chunk.data.indexOf(0); // End of keyword
                    // Check basic structure validity
                    if (nul0 !== -1 && nul0 + 3 <= chunk.length) { // Need keyword, null, comp flag, comp method, null
                        let compFlag = chunk.data[nul0 + 1];
                        let nul1 = chunk.data.indexOf(0, nul0 + 3); // End of language tag
                        if (nul1 !== -1) {
                             let nul2 = chunk.data.indexOf(0, nul1 + 1); // End of translated keyword
                             if (nul2 !== -1) {
                                 if (compFlag === 0) { // Check if uncompressed
                                     // Decode text (UTF8) after translated keyword and null
                                     let text = readUtf8(chunk.data, nul2 + 1, chunk.length - (nul2 + 1));
                                     textContentElement = document.createElement('pre');
                                     textContentElement.className = 'text-content-pre';
                                     textContentElement.textContent = text;
                                 } else {
                                     // Indicate compressed data (decompression not implemented)
                                     textContentElement = createPlaceholderSpan('(Compressed iTXt data - decompression not implemented)');
                                 }
                                 textFound = true;
                             } else { textContentElement = createPlaceholderSpan('(Invalid iTXt format: missing translated keyword terminator)'); textFound = true; }
                        } else { textContentElement = createPlaceholderSpan('(Invalid iTXt format: missing language tag terminator)'); textFound = true; }
                    } else { textContentElement = createPlaceholderSpan('(Invalid iTXt format: missing keyword terminator or flags)'); textFound = true; }
                // Handle zTXt chunks
                } else if (chunk.type === 'zTXt') {
                     let nul = chunk.data.indexOf(0); // Find null terminator for keyword
                     // Check basic structure validity
                     if (nul !== -1 && nul + 2 <= chunk.length) { // Need keyword, null, comp method
                         // Indicate compressed data (decompression not implemented)
                         textContentElement = createPlaceholderSpan('(Compressed zTXt data - decompression not implemented)');
                     } else {
                         textContentElement = createPlaceholderSpan('(Invalid zTXt format)');
                     }
                     textFound = true;
                }

                // If no specific text handling was applied, show a default placeholder
                if (!textFound) {
                    textContentElement = createPlaceholderSpan('— No displayable text content —');
                }

            } catch (e) {
                 // Handle errors during text decoding/processing
                 console.error(`Error processing text content for chunk ${chunk.type} at offset ${chunk.offset}:`, e);
                 textContentElement = createPlaceholderSpan(`(Error processing text: ${escapeHtml(e.message || e.toString())})`);
                 textContentElement.style.color = 'orange'; // Indicate error visually
            }

            // Add the generated text element (<pre> or <span>) to the column
            textCol.appendChild(textContentElement);
            grid.appendChild(textCol);

            // 3. Append the grid to the main chunk container
            chunkContainer.appendChild(grid);
            // 4. Append the completed chunk container to the results area in the HTML
            chunkResultsContainer.appendChild(chunkContainer);
		}
	}

    // Helper function to create a styled placeholder span element.
    function createPlaceholderSpan(text) {
        const span = document.createElement('span');
        span.className = 'text-content-placeholder'; // Apply placeholder styling
        span.textContent = text;
        return span;
    }

    // Helper function to parse IHDR data and return key info.
    // Used to provide context for summarizing other chunks (like tRNS, sBIT, bKGD).
    function parseIhdrData(data) {
        if (data.length !== 13) throw "Invalid IHDR length for parsing"; // Basic validation
        let width = readUint32(data, 0);
        let height = readUint32(data, 4);
        let bitDepth = data[8];
        let colorType = data[9];
        // Validate combination before returning
        if (!isValidBitDepthColorType(bitDepth, colorType)) throw "Invalid bit depth/color type combination in IHDR";
        return { width, height, bitDepth, colorType };
    }

	// Summarizes the data content of a chunk based on its type.
	// Takes ihdrInfo (parsed from IHDR chunk) for context if needed.
	// Throws an error string if the format is invalid for the given chunk type.
	function summarizeChunk(chunk, ihdrInfo) {
		let data = chunk.data;
		let length = chunk.length;
		switch (chunk.type) {
			// --- Critical Chunks ---
			case "IHDR": {
                const parsedIhdr = parseIhdrData(data); // Use helper to parse/validate
				let colorTypeStr; // Get descriptive string for color type
				switch (parsedIhdr.colorType) {
					case 0: colorTypeStr = "Grayscale"; break;
					case 2: colorTypeStr = "Truecolor (RGB)"; break;
					case 3: colorTypeStr = "Indexed-color"; break;
					case 4: colorTypeStr = "Grayscale + Alpha"; break;
					case 6: colorTypeStr = "Truecolor + Alpha (RGBA)"; break;
					default: colorTypeStr = "Invalid"; // Should be caught by parseIhdrData
				}
                // Read other fields directly for summary string
                let compressionMethod = data[10];
				let filterMethod = data[11];
				let interlaceMethod = data[12];
                // Construct summary string
				return `Dimensions: ${parsedIhdr.width} x ${parsedIhdr.height}, Bit Depth: ${parsedIhdr.bitDepth}, Color Type: ${parsedIhdr.colorType} (${colorTypeStr}), Compression: ${compressionMethod}, Filter: ${filterMethod}, Interlace: ${interlaceMethod}`;
			}
			case "PLTE": {
                // Validate length: must be multiple of 3, max 256 entries, not empty
				if (length % 3 !== 0 || length > 256*3 || length === 0) throw "Invalid PLTE length";
				return `Palette entries: ${length / 3}`;
			}
			case "IDAT": {
				return "Image data stream chunk"; // Simple description
			}
			case "IEND": {
				if (length !== 0) throw "Invalid IEND length (must be 0)";
				return "End of image stream marker";
			}

			// --- Ancillary Chunks (Common) ---
			case "tRNS": {
                // Summary depends heavily on IHDR color type for validation
                let details = "";
                if (ihdrInfo) { // Use context if available
                    switch (ihdrInfo.colorType) {
                        case 0: // Grayscale: 2 bytes for transparent gray level
                             if (length !== 2) throw "Invalid tRNS length for grayscale (must be 2)";
                             details = `Single Gray Level=${readUint16(data, 0)}`;
                             break;
                        case 2: // Truecolor: 6 bytes for transparent RGB color
                             if (length !== 6) throw "Invalid tRNS length for truecolor (must be 6)";
                             details = `Single RGB Color: R=${readUint16(data,0)}, G=${readUint16(data,2)}, B=${readUint16(data,4)}`;
                             break;
                        case 3: // Indexed: 1 byte per palette entry (up to PLTE size)
                             if (length === 0 || length > 256) throw "Invalid tRNS length for indexed (must be 1-256)";
                             details = `${length} alpha entries for palette`;
                             break;
                        default: // tRNS is invalid for color types 4 and 6 (which have alpha channel)
                             throw "tRNS chunk is invalid for color types with an alpha channel (4 or 6)";
                    }
                } else { // No context available
                    details = `(${length} bytes, requires IHDR context for details)`;
                }
				return `Transparency Data: ${details}`;
			}
			case "cHRM": { // Chromaticities and White Point
				if (length !== 32) throw "Invalid cHRM length (must be 32)";
				// Read values (scaled by 100,000)
				let whiteX = readUint32(data, 0) / 100000;
				let whiteY = readUint32(data, 4) / 100000;
				let redX = readUint32(data, 8) / 100000;
				let redY = readUint32(data, 12) / 100000;
				let greenX = readUint32(data, 16) / 100000;
				let greenY = readUint32(data, 20) / 100000;
				let blueX = readUint32(data, 24) / 100000;
				let blueY = readUint32(data, 28) / 100000;
				// Format summary string with reasonable precision
				return `Chromaticities: White(${whiteX.toFixed(4)},${whiteY.toFixed(4)}), R(${redX.toFixed(4)},${redY.toFixed(4)}), G(${greenX.toFixed(4)},${greenY.toFixed(4)}), B(${blueX.toFixed(4)},${blueY.toFixed(4)})`;
			}
			case "gAMA": { // Image Gamma
				if (length !== 4) throw "Invalid gAMA length (must be 4)";
				let gamma = readUint32(data, 0) / 100000; // Scaled by 100,000
				return `Image Gamma=${gamma.toFixed(5)}`;
			}
			case "iCCP": { // Embedded ICC Profile
				let nul = data.indexOf(0); // Find null terminator for profile name
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid iCCP profile name (missing, too long, or empty)";
				let name = readLatin1(data, 0, nul);
				if (nul + 2 > length) throw "Invalid iCCP data (missing compression method)";
				let compMethod = data[nul + 1];
				if (compMethod !== 0) throw "Invalid iCCP compression method (only 0 allowed by spec)";
				// Actual profile data follows compMethod, usually compressed
				return `Embedded ICC Profile: Name="${escapeHtml(name)}", Compression Method=${compMethod}`;
			}
			case "sBIT": { // Significant Bits
                // Summary depends on IHDR color type
                let details = "";
                 if (ihdrInfo) { // Use context if available
                    switch (ihdrInfo.colorType) {
                        case 0: // Grayscale (1 byte)
                             if (length !== 1) throw "Invalid sBIT length for grayscale (must be 1)";
                             details = `Gray=${data[0]}`; break;
                        case 2: // Truecolor (3 bytes: R,G,B)
                             if (length !== 3) throw "Invalid sBIT length for truecolor (must be 3)";
                             details = `R=${data[0]}, G=${data[1]}, B=${data[2]}`; break;
                        case 3: // Indexed (3 bytes: R,G,B for source palette)
                             if (length !== 3) throw "Invalid sBIT length for indexed (must be 3)";
                             details = `Source Palette: R=${data[0]}, G=${data[1]}, B=${data[2]}`; break;
                        case 4: // Grayscale + Alpha (2 bytes: Gray, Alpha)
                             if (length !== 2) throw "Invalid sBIT length for grayscale+alpha (must be 2)";
                             details = `Gray=${data[0]}, Alpha=${data[1]}`; break;
                        case 6: // Truecolor + Alpha (4 bytes: R,G,B,A)
                             if (length !== 4) throw "Invalid sBIT length for truecolor+alpha (must be 4)";
                             details = `R=${data[0]}, G=${data[1]}, B=${data[2]}, A=${data[3]}`; break;
                        default: details = "(Invalid color type for sBIT)";
                    }
                 } else { // No context
                     details = `(${length} bytes, requires IHDR context for details)`;
                 }
				return `Significant Bits: ${details}`;
			}
			case "sRGB": { // Standard RGB Color Space information
				if (length !== 1) throw "Invalid sRGB length (must be 1)";
				let renderingIntent = data[0];
				let intentStr; // Get descriptive string for intent
				switch (renderingIntent) {
					case 0: intentStr = "Perceptual"; break;
					case 1: intentStr = "Relative colorimetric"; break;
					case 2: intentStr = "Saturation"; break;
					case 3: intentStr = "Absolute colorimetric"; break;
					default: throw "Invalid sRGB rendering intent value";
				}
				return `sRGB Rendering Intent: ${renderingIntent} (${intentStr})`;
			}
			case "iTXt": { // International Textual Data (UTF-8)
				let nul0 = data.indexOf(0); // End of keyword
				if (nul0 === -1 || nul0 > 79 || nul0 === 0) throw "Invalid iTXt keyword";
				let keyword = readLatin1(data, 0, nul0); // Keyword is Latin1
				if (nul0 + 3 > length) throw "Invalid iTXt data (too short for flags/tags)";
				let compFlag = data[nul0 + 1]; // 0=uncompressed, 1=compressed
				let compMethod = data[nul0 + 2]; // Must be 0 if compFlag=1
				if (compFlag !== 0 && compFlag !== 1) throw "Invalid iTXt compression flag";
				if (compFlag === 1 && compMethod !== 0) throw "Invalid iTXt compression method (must be 0 if compressed)";
				let nul1 = data.indexOf(0, nul0 + 3); // End of language tag
				if (nul1 === -1) throw "Invalid iTXt data (missing language tag terminator)";
				let langTag = readLatin1(data, nul0 + 3, nul1 - (nul0 + 3)); // Language tag is Latin1
				let nul2 = data.indexOf(0, nul1 + 1); // End of translated keyword
				if (nul2 === -1) throw "Invalid iTXt data (missing translated keyword terminator)";
				let translatedKeyword = readUtf8(data, nul1 + 1, nul2 - (nul1 + 1)); // Translated keyword is UTF-8
				// Text itself (after nul2+1) is shown in the dedicated column
				return `Intl Text: Key="${escapeHtml(keyword)}", Comp Flag=${compFlag}, Lang="${escapeHtml(langTag)}", Trans Key="${escapeHtml(translatedKeyword)}"`;
			}
			case "tEXt": { // Textual Data (Latin-1)
				let nul = data.indexOf(0); // Find null terminator for keyword
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid tEXt keyword";
				let keyword = readLatin1(data, 0, nul);
				// Text itself (after nul+1) is shown in the dedicated column
				return `Textual Data: Key="${escapeHtml(keyword)}"`;
			}
			case "zTXt": { // Compressed Textual Data (Latin-1)
				let nul = data.indexOf(0); // Find null terminator for keyword
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid zTXt keyword";
				let keyword = readLatin1(data, 0, nul);
				if (nul + 2 > length) throw "Invalid zTXt data (missing compression method)";
				let compMethod = data[nul + 1];
				if (compMethod !== 0) throw "Invalid zTXt compression method (must be 0)";
				// Compressed text (after nul+2) is noted in the dedicated column
				return `Compressed Text: Key="${escapeHtml(keyword)}", Method=${compMethod}`;
			}
			case "bKGD": { // Background Color
                // Summary depends on IHDR color type
                let details = "";
                 if (ihdrInfo) { // Use context if available
                    switch (ihdrInfo.colorType) {
                        case 0: case 4: // Grayscale types (2 bytes: gray level)
                             if (length !== 2) throw "Invalid bKGD length for grayscale (must be 2)";
                             details = `Gray Level=${readUint16(data, 0)}`; break;
                        case 2: case 6: // Truecolor types (6 bytes: R,G,B)
                             if (length !== 6) throw "Invalid bKGD length for truecolor (must be 6)";
                             details = `RGB Color: R=${readUint16(data,0)}, G=${readUint16(data,2)}, B=${readUint16(data,4)}`; break;
                        case 3: // Indexed type (1 byte: palette index)
                             if (length !== 1) throw "Invalid bKGD length for indexed (must be 1)";
                             details = `Palette Index=${data[0]}`; break;
                        default: details = "(Invalid color type for bKGD)";
                    }
                 } else { // No context
                     details = `(${length} bytes, requires IHDR context for details)`;
                 }
				return `Background Color: ${details}`;
			}
			case "hIST": { // Palette Histogram
                // Length must be even, 2 bytes per entry
				if (length % 2 !== 0 || length === 0) throw "Invalid hIST length (must be even and non-zero)";
                // Full validation requires PLTE chunk context (length must = 2 * num_palette_entries)
				return `Palette Histogram: Entries=${length / 2}`;
			}
			case "pHYs": { // Physical Pixel Dimensions
				if (length !== 9) throw "Invalid pHYs length (must be 9)";
				let ppuX = readUint32(data, 0); // Pixels per unit, X axis
				let ppuY = readUint32(data, 4); // Pixels per unit, Y axis
				let unitSpec = data[8]; // Unit specifier (0=unknown, 1=metre)
				let unitStr;
				if (unitSpec === 0) unitStr = "Unknown unit";
				else if (unitSpec === 1) unitStr = "Pixels per metre";
				else throw "Invalid pHYs unit specifier (must be 0 or 1)";
				return `Physical Dimensions: PPU X=${ppuX}, PPU Y=${ppuY}, Unit=${unitSpec} (${unitStr})`;
			}
			case "sPLT": { // Suggested Palette
				let nul = data.indexOf(0); // Find null terminator for palette name
				if (nul === -1 || nul > 79 || nul === 0) throw "Invalid sPLT palette name";
				let name = readLatin1(data, 0, nul);
				if (nul + 2 > length) throw "Invalid sPLT data (missing sample depth)";
				let sampleDepth = data[nul + 1]; // Sample depth (8 or 16)
				if (sampleDepth !== 8 && sampleDepth !== 16) throw "Invalid sPLT sample depth (must be 8 or 16)";
                // Calculate entry size based on sample depth: R,G,B,A (1 or 2 bytes each) + Frequency (2 bytes)
				let entrySize = (sampleDepth === 8 ? 6 : 10);
                let paletteDataLength = length - (nul + 1 + 1); // Length of the actual palette entries
				if (paletteDataLength < 0 || paletteDataLength % entrySize !== 0) throw `Invalid sPLT data length for ${sampleDepth}-bit entries`;
				let numEntries = paletteDataLength / entrySize;
				return `Suggested Palette: Name="${escapeHtml(name)}", Sample Depth=${sampleDepth}, Entries=${numEntries}`;
			}
			case "tIME": { // Last Modification Time
				if (length !== 7) throw "Invalid tIME length (must be 7)";
				let year = readUint16(data, 0); // Year (4 digits)
				let month = data[2]; // Month (1-12)
				let day = data[3]; // Day (1-31)
				let hour = data[4]; // Hour (0-23)
				let minute = data[5]; // Minute (0-59)
				let second = data[6]; // Second (0-60, 60 for leap second)
                // Basic validation of date/time values
				if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60)
					throw "Invalid date/time value in tIME chunk";
                // Format nicely with padding
				return `Last Modified: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')} UTC`; // Assume UTC per spec
			}
            // --- Other Ancillary Chunks ---
			case "eXIf": { // Exchangeable Image File Format (Exif) data
				return `Exif Metadata chunk (${length} bytes)`; // Content not parsed here
			}
			// --- APNG (Animation) Chunks ---
			case "acTL": { // Animation Control Chunk
				if (length !== 8) throw "Invalid acTL length (must be 8)";
				let numFrames = readUint32(data, 0); // Total number of frames
				let numPlays = readUint32(data, 4); // Number of times to loop (0=infinite)
				return `APNG Control: Frames=${numFrames}, Plays=${numPlays === 0 ? 'Infinite' : numPlays}`;
			}
			case "fcTL": { // Frame Control Chunk
				if (length !== 26) throw "Invalid fcTL length (must be 26)";
				let sequenceNumber = readUint32(data, 0);
				let width = readUint32(data, 4); // Frame width
				let height = readUint32(data, 8); // Frame height
				let xOffset = readUint32(data, 12); // Frame X offset
				let yOffset = readUint32(data, 16); // Frame Y offset
				let delayNum = readUint16(data, 20); // Frame delay numerator
				let delayDen = readUint16(data, 22); // Frame delay denominator (0 means 100)
				let disposeOp = data[24]; // Dispose operation (0-2)
				let blendOp = data[25]; // Blend operation (0-1)
                // Validate values
				if (width === 0 || height === 0) throw "Invalid fcTL: Zero frame width or height";
                let effectiveDelayDen = (delayDen === 0) ? 100 : delayDen; // Handle denominator=0 case
				if (disposeOp > 2) throw "Invalid fcTL dispose operation";
				if (blendOp > 1) throw "Invalid fcTL blend operation";
                // Format delay and operation codes descriptively
                let delay = (effectiveDelayDen === 0) ? "N/A" : (delayNum / effectiveDelayDen).toFixed(4) + "s";
                const disposeMap = ["None", "Background", "Previous"];
                const blendMap = ["Source", "Over"];
				return `APNG Frame Ctrl: Seq=${sequenceNumber}, Dim=${width}x${height}, Off=(${xOffset},${yOffset}), Delay=${delay}, Disp=${disposeMap[disposeOp] || 'Invalid'}, Blend=${blendMap[blendOp] || 'Invalid'}`;
			}
			case "fdAT": { // Frame Data Chunk (like IDAT but for animation frames)
				if (length < 4) throw "Invalid fdAT length (must be >= 4)";
				let sequenceNumber = readUint32(data, 0); // Sequence number for this frame's data
				// Actual frame data follows sequence number
				return `APNG Frame Data: Seq=${sequenceNumber}`;
			}
			// --- Unknown Chunks ---
			default: {
				// Check if first character of type is lowercase (ancillary) or uppercase (critical)
				if (/^[a-z]/.test(chunk.type.charAt(0)))
					return `Ancillary chunk ("${escapeHtml(chunk.type)}")`; // Use escapeHtml for safety
				else
					return `Critical chunk ("${escapeHtml(chunk.type)}")`; // Use escapeHtml for safety
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
		// Check if the colorType exists as a key and the bitDepth is included in its array
		return validCombinations[colorType]?.includes(bitDepth) ?? false;
	}


	/*---- Utilities ----*/

	// Reads a 16-bit unsigned integer (big-endian) from byte array. Includes boundary check.
	function readUint16(bytes, offset) {
        if (offset + 2 > bytes.length) throw `Read past end of buffer (Uint16 at offset ${offset})`;
		return (bytes[offset] << 8) | bytes[offset + 1];
	}

	// Reads a 32-bit unsigned integer (big-endian) from byte array. Includes boundary check.
	function readUint32(bytes, offset) {
        if (offset + 4 > bytes.length) throw `Read past end of buffer (Uint32 at offset ${offset})`;
		// Use bit shifts and unsigned right shift (>>> 0) for correct positive result
		return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
	}

	// Reads ASCII string (1 byte per char) from byte array. Includes boundary check.
	function readAscii(bytes, offset, len) {
        if (offset + len > bytes.length) throw `Read past end of buffer (ASCII: offset ${offset}, len=${len})`;
		let result = "";
		for (let i = 0; i < len; i++) {
            let charCode = bytes[offset + i];
            // Basic ASCII validation (optional but good practice)
            if (charCode < 0 || charCode > 127) console.warn(`Non-ASCII char code ${charCode} found in ASCII string at offset ${offset + i}`);
			result += String.fromCharCode(charCode);
        }
		return result;
	}

	// Reads Latin-1 string (ISO-8859-1, 1 byte per char) from byte array. Includes boundary check.
	function readLatin1(bytes, offset, len) {
        if (offset + len > bytes.length) throw `Read past end of buffer (Latin1: offset ${offset}, len=${len})`;
        let result = "";
        // Directly map byte values to character codes (0-255)
        for (let i = 0; i < len; i++) {
            result += String.fromCharCode(bytes[offset + i]);
        }
        return result;
	}

	// Reads UTF-8 string from byte array using TextDecoder. Includes boundary check and error handling.
	function readUtf8(bytes, offset, len) {
        if (offset + len > bytes.length) throw `Read past end of buffer (UTF8: offset ${offset}, len=${len})`;
        let subarray = bytes.subarray(offset, offset + len); // Get the relevant part of the byte array
		try {
            // Use TextDecoder for robust UTF-8 decoding, fatal=true throws error on invalid sequences
		    return new TextDecoder("utf-8", { fatal: true }).decode(subarray);
        } catch (e) {
            // Provide more context on error
            throw `Invalid UTF-8 sequence found (offset ${offset}, length ${len}): ${e.message}`;
        }
	}

	// Formats a number with thousands separators (e.g., 12345 -> "12,345").
	function formatNumber(n) {
        if (typeof n !== 'number') return String(n); // Handle non-numeric input gracefully
		return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	}

	// Formats a number as uppercase hexadecimal string, padded with leading zeros to the specified number of digits.
	function formatHex(n, digits) {
        if (typeof n !== 'number') return String(n); // Handle non-numeric input gracefully
		return n.toString(16).toUpperCase().padStart(digits, "0");
	}

    // Basic HTML escaping function to prevent XSS issues when displaying text content.
    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return unsafe; // Return non-strings as-is
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
     }

}; // End of app scope
