// make-icon.swift — render PlugWatch's app icons, or a contact sheet of variants.
//
// The icons are drawn at runtime (gradient squircle + an SF Symbol glyph) so no
// binary artwork lives in the repo. `scripts/build-notify.sh` uses this to pack
// `AppIcon.icns` into the notification bundles.
//
// Usage:
//   swift swift/make-icon.swift <out.iconset> [style]   # one iconset (default style: ac)
//   swift swift/make-icon.swift --sheet <out.png>       # compare every style
//
// Follows Apple's macOS icon grid: artwork spans 824 of the 1024 canvas with a
// 185.4 corner radius.
//
// Each style is `glyphs + palette`. The first available glyph wins, so a style
// degrades instead of failing on an older macOS.

import AppKit
import Foundation

/// One visual identity: candidate glyphs (first available wins) and a gradient.
struct Style {
	let key: String
	let label: String
	let glyphs: [String]
	let start: NSColor
	let end: NSColor
}

func rgb(_ r: Double, _ g: Double, _ b: Double) -> NSColor {
	NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: 1)
}

/// Everything on offer. Keep `ac` and `battery` stable — the build script names
/// bundles after them.
let STYLES: [Style] = [
	Style(
		key: "ac",
		label: "AC — current (plug, indigo\u{2192}cyan)",
		glyphs: ["powerplug", "power"],
		start: rgb(92, 89, 250),
		end: rgb(10, 215, 239)
	),
	Style(
		key: "ac-teal",
		label: "AC — teal\u{2192}green (plug)",
		glyphs: ["powerplug", "power"],
		start: rgb(28, 158, 158),
		end: rgb(76, 204, 97)
	),
	Style(
		key: "ac-deep",
		label: "AC — deep blue (plug)",
		glyphs: ["powerplug", "power"],
		start: rgb(26, 64, 158),
		end: rgb(51, 140, 235)
	),
	Style(
		key: "battery",
		label: "Battery — current (soft orange)",
		glyphs: ["battery.100", "battery.75"],
		start: rgb(252, 190, 124),
		end: rgb(236, 134, 72)
	),
	Style(
		key: "battery-amber",
		label: "Battery — amber (brighter)",
		glyphs: ["battery.100", "battery.75"],
		start: rgb(253, 210, 120),
		end: rgb(242, 158, 38)
	),
	Style(
		key: "battery-plug",
		label: "Battery — plug glyph, colour only",
		glyphs: ["powerplug", "power"],
		start: rgb(252, 190, 124),
		end: rgb(236, 134, 72)
	),
	Style(
		key: "battery-bolt",
		label: "Battery — bolt glyph",
		glyphs: ["bolt.fill", "power"],
		start: rgb(252, 190, 124),
		end: rgb(236, 134, 72)
	),
]

func style(for key: String) -> Style {
	STYLES.first { $0.key == key } ?? STYLES[0]
}

let contentRatio: CGFloat = 824.0 / 1024.0
let cornerRatio: CGFloat = 185.4 / 824.0

/// Glyph width as a fraction of the artwork side.
let glyphWidthRatio: CGFloat = 0.56

/// Render one square icon in the given style.
func drawIcon(size: CGFloat, style: Style) -> NSBitmapImageRep? {
	let pixels = Int(size)
	guard
		let rep = NSBitmapImageRep(
			bitmapDataPlanes: nil,
			pixelsWide: pixels,
			pixelsHigh: pixels,
			bitsPerSample: 8,
			samplesPerPixel: 4,
			hasAlpha: true,
			isPlanar: false,
			colorSpaceName: .deviceRGB,
			bytesPerRow: 0,
			bitsPerPixel: 0
		)
	else { return nil }
	rep.size = NSSize(width: size, height: size)

	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

	let side = size * contentRatio
	let inset = (size - side) / 2
	let rect = NSRect(x: inset, y: inset, width: side, height: side)
	let path = NSBezierPath(roundedRect: rect, xRadius: side * cornerRatio, yRadius: side * cornerRatio)

	let gradient = NSGradient(starting: style.start, ending: style.end)
	gradient?.draw(in: path, angle: -90)

	let symbolName = style.glyphs.first { NSImage(systemSymbolName: $0, accessibilityDescription: nil) != nil } ?? "power"
	if let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
		// Colour the symbol via a palette configuration and draw it normally.
		// (A CGContext.clip(to:mask:) tint would need a *grayscale, alpha-less*
		// mask image — handing it the RGBA glyph clips everything away and the
		// icon comes out blank.)
		let config = NSImage.SymbolConfiguration(pointSize: side * 0.9, weight: .semibold)
			.applying(NSImage.SymbolConfiguration(paletteColors: [NSColor.white]))
		if let configured = symbol.withSymbolConfiguration(config) {
			let width = side * glyphWidthRatio
			let ratio = configured.size.height / max(configured.size.width, 1)
			let height = width * ratio
			let target = NSRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
			configured.draw(in: target, from: .zero, operation: .sourceOver, fraction: 1.0)
		}
	}

	NSGraphicsContext.restoreGraphicsState()
	return rep
}

/// The exact filenames `iconutil` expects, with their pixel sizes.
let variants: [(name: String, pixels: Int)] = [
	("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
	("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
	("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
	("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
	("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

func fail(_ message: String) -> Never {
	FileHandle.standardError.write(Data((message + "\n").utf8))
	exit(1)
}

/// Write one complete .iconset for a style.
func writeIconset(to outDir: String, style: Style) {
	try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
	for variant in variants {
		guard let rep = drawIcon(size: CGFloat(variant.pixels), style: style),
			let data = rep.representation(using: .png, properties: [:])
		else { fail("failed to render \(variant.name)") }
		do {
			try data.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(variant.name))
		} catch {
			fail("failed to write \(variant.name): \(error)")
		}
	}
	print("rendered \(variants.count) sizes for style '\(style.key)'")
}

/// Render every style side by side, labelled, so the palettes can be compared.
func writeSheet(to path: String) {
	let cell: CGFloat = 220
	let labelHeight: CGFloat = 54
	let gap: CGFloat = 28
	let columns = 4
	let rows = Int((Double(STYLES.count) / Double(columns)).rounded(.up))
	let width = CGFloat(columns) * (cell + gap) + gap
	let height = CGFloat(rows) * (cell + labelHeight + gap) + gap

	guard
		let sheet = NSBitmapImageRep(
			bitmapDataPlanes: nil,
			pixelsWide: Int(width),
			pixelsHigh: Int(height),
			bitsPerSample: 8,
			samplesPerPixel: 4,
			hasAlpha: true,
			isPlanar: false,
			colorSpaceName: .deviceRGB,
			bytesPerRow: 0,
			bitsPerPixel: 0
		)
	else { fail("failed to allocate sheet") }
	sheet.size = NSSize(width: width, height: height)

	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: sheet)

	// Light background so the transparent squircles are legible.
	NSColor(srgbRed: 0.96, green: 0.96, blue: 0.97, alpha: 1).setFill()
	NSRect(x: 0, y: 0, width: width, height: height).fill()

	let labelStyle: [NSAttributedString.Key: Any] = [
		.font: NSFont.systemFont(ofSize: 14, weight: .medium),
		.foregroundColor: NSColor(srgbRed: 0.15, green: 0.15, blue: 0.18, alpha: 1),
	]

	for (index, style) in STYLES.enumerated() {
		let column = index % columns
		let row = index / columns
		// NSBitmapImageRep's origin is bottom-left, so rows are laid out from the top.
		let cellLeft = gap + CGFloat(column) * (cell + gap)
		let cellTop = gap + CGFloat(row) * (cell + labelHeight + gap)
		let iconY = height - cellTop - cell
		guard let icon = drawIcon(size: cell, style: style) else { continue }
		icon.draw(in: NSRect(x: cellLeft, y: iconY, width: cell, height: cell))

		let label = NSAttributedString(string: style.label, attributes: labelStyle)
		let labelRect = NSRect(x: cellLeft - gap / 2, y: iconY - labelHeight, width: cell + gap, height: labelHeight)
		label.draw(in: labelRect)
	}

	NSGraphicsContext.restoreGraphicsState()

	guard let data = sheet.representation(using: .png, properties: [:]) else { fail("failed to encode sheet") }
	do {
		try data.write(to: URL(fileURLWithPath: path))
	} catch {
		fail("failed to write \(path): \(error)")
	}
	print("wrote \(path) with \(STYLES.count) styles")
}

// MARK: - Combined icons (AC + battery in one mark)

/// Ways to fold both power states into a single app icon.
enum Combo: CaseIterable {
	// First round
	case splitFace
	case verticalSplit
	case stackedCards
	case blended
	case seamBolt
	// Second round
	case batteryShell
	case venn
	case ring
	case toggle
	case ribbon

	var key: String {
		switch self {
		case .splitFace: return "combo-split-face"
		case .verticalSplit: return "combo-vertical"
		case .stackedCards: return "combo-cards"
		case .blended: return "combo-blend"
		case .seamBolt: return "combo-seam-bolt"
		case .batteryShell: return "combo-battery-shell"
		case .venn: return "combo-venn"
		case .ring: return "combo-ring"
		case .toggle: return "combo-toggle"
		case .ribbon: return "combo-ribbon"
		}
	}

	var label: String {
		switch self {
		case .splitFace: return "Split face \u{2014} diagonal, one glyph per half"
		case .verticalSplit: return "Vertical split \u{2014} plug | battery"
		case .stackedCards: return "Stacked cards \u{2014} two squircles offset"
		case .blended: return "Blended \u{2014} one gradient, both glyphs"
		case .seamBolt: return "Seam + bolt \u{2014} AC above, battery below"
		case .batteryShell: return "Battery shell \u{2014} the states live inside a battery"
		case .venn: return "Venn \u{2014} two states overlapping"
		case .ring: return "Ring + bolt \u{2014} split donut around a switch"
		case .toggle: return "Toggle \u{2014} a switch, half AC half battery"
		case .ribbon: return "Ribbon \u{2014} battery field, AC band across it"
		}
	}
}

func acGradient() -> NSGradient {
	NSGradient(starting: rgb(92, 89, 250), ending: rgb(10, 215, 239))!
}

func batteryGradient() -> NSGradient {
	NSGradient(starting: rgb(252, 190, 124), ending: rgb(236, 134, 72))!
}

/// Draw a white SF Symbol centred on a point, at a given width.
func drawGlyph(_ name: String, center: NSPoint, width: CGFloat) {
	guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return }
	let config = NSImage.SymbolConfiguration(pointSize: width * 1.6, weight: .semibold)
		.applying(NSImage.SymbolConfiguration(paletteColors: [NSColor.white]))
	guard let configured = symbol.withSymbolConfiguration(config) else { return }
	let ratio = configured.size.height / max(configured.size.width, 1)
	let height = width * ratio
	let target = NSRect(x: center.x - width / 2, y: center.y - height / 2, width: width, height: height)
	configured.draw(in: target, from: .zero, operation: .sourceOver, fraction: 1.0)
}

/// Fill `shape` (already clipped to the squircle) with a gradient.
func fill(_ path: NSBezierPath, gradient: NSGradient, in rect: NSRect) {
	NSGraphicsContext.saveGraphicsState()
	path.addClip()
	gradient.draw(in: rect, angle: -90)
	NSGraphicsContext.restoreGraphicsState()
}

func renderCombo(size: CGFloat, combo: Combo) -> NSBitmapImageRep? {
	let pixels = Int(size)
	guard
		let rep = NSBitmapImageRep(
			bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
			bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
			colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
		)
	else { return nil }
	rep.size = NSSize(width: size, height: size)

	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

	let side = size * contentRatio
	let inset = (size - side) / 2
	let rect = NSRect(x: inset, y: inset, width: side, height: side)
	let squircle = NSBezierPath(roundedRect: rect, xRadius: side * cornerRatio, yRadius: side * cornerRatio)
	let ac = acGradient()
	let battery = batteryGradient()

	switch combo {
	case .splitFace:
		// Diagonal 50/50, like the old Finder icon's split face.
		NSGraphicsContext.saveGraphicsState()
		squircle.addClip()
		let upperLeft = NSBezierPath()
		upperLeft.move(to: NSPoint(x: rect.minX, y: rect.minY))
		upperLeft.line(to: NSPoint(x: rect.minX, y: rect.maxY))
		upperLeft.line(to: NSPoint(x: rect.maxX, y: rect.maxY))
		upperLeft.close()
		fill(upperLeft, gradient: ac, in: rect)

		let lowerRight = NSBezierPath()
		lowerRight.move(to: NSPoint(x: rect.minX, y: rect.minY))
		lowerRight.line(to: NSPoint(x: rect.maxX, y: rect.minY))
		lowerRight.line(to: NSPoint(x: rect.maxX, y: rect.maxY))
		lowerRight.close()
		fill(lowerRight, gradient: battery, in: rect)
		NSGraphicsContext.restoreGraphicsState()

		drawGlyph("powerplug", center: NSPoint(x: rect.minX + side * 0.32, y: rect.minY + side * 0.62), width: side * 0.30)
		drawGlyph("battery.100", center: NSPoint(x: rect.minX + side * 0.66, y: rect.minY + side * 0.33), width: side * 0.34)

	case .verticalSplit:
		NSGraphicsContext.saveGraphicsState()
		squircle.addClip()
		let left = NSBezierPath(rect: NSRect(x: rect.minX, y: rect.minY, width: rect.width / 2, height: rect.height))
		fill(left, gradient: ac, in: rect)
		let right = NSBezierPath(rect: NSRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height))
		fill(right, gradient: battery, in: rect)
		// Hairline seam keeps the two halves from reading as one muddy surface.
		NSColor(white: 1, alpha: 0.55).setFill()
		NSRect(x: rect.midX - side * 0.006, y: rect.minY, width: side * 0.012, height: rect.height).fill()
		NSGraphicsContext.restoreGraphicsState()

		drawGlyph("powerplug", center: NSPoint(x: rect.minX + side * 0.25, y: rect.midY), width: side * 0.30)
		drawGlyph("battery.100", center: NSPoint(x: rect.minX + side * 0.75, y: rect.midY), width: side * 0.36)

	case .stackedCards:
		// Two cards on a deck: AC behind, battery in front.
		let card = side * 0.68
		let cardRadius = side * 0.145
		let back = NSRect(x: rect.minX + side * 0.03, y: rect.minY + side * 0.29, width: card, height: card)
		let front = NSRect(x: rect.minX + side * 0.29, y: rect.minY + side * 0.03, width: card, height: card)

		let backPath = NSBezierPath(roundedRect: back, xRadius: cardRadius, yRadius: cardRadius)
		fill(backPath, gradient: ac, in: back)

		let frontPath = NSBezierPath(roundedRect: front, xRadius: cardRadius, yRadius: cardRadius)
		// A soft rim separates the front card from the one behind it.
		NSGraphicsContext.saveGraphicsState()
		frontPath.addClip()
		battery.draw(in: front, angle: -90)
		NSGraphicsContext.restoreGraphicsState()
		NSColor(white: 1, alpha: 0.65).setStroke()
		frontPath.lineWidth = side * 0.018
		frontPath.stroke()

		drawGlyph("powerplug", center: NSPoint(x: back.midX, y: back.midY), width: card * 0.46)
		drawGlyph("battery.100", center: NSPoint(x: front.midX, y: front.midY), width: card * 0.54)

	case .blended:
		// One continuous surface: AC tones up top cooling into battery tones below.
		let blend = NSGradient(colors: [
			rgb(92, 89, 250), rgb(10, 215, 239), rgb(252, 190, 124), rgb(236, 134, 72),
		])!
		fill(squircle, gradient: blend, in: rect)

		drawGlyph("powerplug", center: NSPoint(x: rect.minX + side * 0.33, y: rect.minY + side * 0.63), width: side * 0.30)
		drawGlyph("battery.100", center: NSPoint(x: rect.minX + side * 0.67, y: rect.minY + side * 0.32), width: side * 0.34)

	case .seamBolt:
		NSGraphicsContext.saveGraphicsState()
		squircle.addClip()
		let top = NSBezierPath(rect: NSRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2))
		fill(top, gradient: ac, in: rect)
		let bottom = NSBezierPath(rect: NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height / 2))
		fill(bottom, gradient: battery, in: rect)
		NSGraphicsContext.restoreGraphicsState()

		drawGlyph("powerplug", center: NSPoint(x: rect.minX + side * 0.30, y: rect.minY + side * 0.74), width: side * 0.26)
		drawGlyph("battery.100", center: NSPoint(x: rect.minX + side * 0.70, y: rect.minY + side * 0.24), width: side * 0.32)
		// The switch itself, straddling the seam.
		drawGlyph("bolt.fill", center: NSPoint(x: rect.midX, y: rect.midY), width: side * 0.34)

	case .batteryShell:
		// The metaphor is the container: a battery whose two halves are the states.
		let bodyW = side * 0.68
		let bodyH = side * 0.40
		let body = NSRect(x: rect.midX - bodyW / 2 - side * 0.03, y: rect.midY - bodyH / 2, width: bodyW, height: bodyH)
		let nub = NSRect(
			x: body.maxX + side * 0.015, y: rect.midY - bodyH * 0.16,
			width: side * 0.045, height: bodyH * 0.32
		)
		let shell = NSBezierPath(roundedRect: body, xRadius: bodyH * 0.30, yRadius: bodyH * 0.30)

		for (half, gradient) in [(0, ac), (1, battery)] {
			NSGraphicsContext.saveGraphicsState()
			shell.addClip()
			NSBezierPath(rect: 
				NSRect(
					x: body.minX + body.width / 2 * CGFloat(half), y: body.minY,
					width: body.width / 2, height: body.height
				)
			).addClip()
			gradient.draw(in: body, angle: -90)
			NSGraphicsContext.restoreGraphicsState()
		}
		let nubPath = NSBezierPath(roundedRect: nub, xRadius: nub.height * 0.35, yRadius: nub.height * 0.35)
		fill(nubPath, gradient: battery, in: nub)
		NSColor(white: 1, alpha: 0.9).setStroke()
		shell.lineWidth = side * 0.014
		shell.stroke()

	case .venn:
		// Two states that overlap rather than abut.
		squircle.addClip()
		let radius = side * 0.31
		for (center, gradient) in [
			(NSPoint(x: rect.minX + side * 0.36, y: rect.minY + side * 0.62), ac),
			(NSPoint(x: rect.minX + side * 0.64, y: rect.minY + side * 0.38), battery),
		] {
			NSGraphicsContext.saveGraphicsState()
			NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
				.addClip()
			gradient.draw(in: rect, angle: -90)
			NSGraphicsContext.restoreGraphicsState()
		}

	case .ring:
		// A half-and-half donut, with the switch sitting in the hole.
		let outer = side * 0.40
		let inner = side * 0.235
		let ring = NSBezierPath(
			ovalIn: NSRect(x: rect.midX - outer, y: rect.midY - outer, width: outer * 2, height: outer * 2)
		)
		ring.appendOval(
			in: NSRect(x: rect.midX - inner, y: rect.midY - inner, width: inner * 2, height: inner * 2)
		)
		ring.windingRule = .evenOdd
		for (half, gradient) in [(0, ac), (1, battery)] {
			NSGraphicsContext.saveGraphicsState()
			ring.addClip()
			NSBezierPath(rect: 
				NSRect(x: rect.minX + rect.width / 2 * CGFloat(half), y: rect.minY, width: rect.width / 2, height: rect.height)
			).addClip()
			gradient.draw(in: rect, angle: -90)
			NSGraphicsContext.restoreGraphicsState()
		}
		drawGlyph("bolt.fill", center: NSPoint(x: rect.midX, y: rect.midY), width: side * 0.24)

	case .toggle:
		// The product's whole job, as a macOS toggle: a track split by state.
		let trackW = side * 0.84
		let trackH = side * 0.46
		let track = NSRect(x: rect.midX - trackW / 2, y: rect.midY - trackH / 2, width: trackW, height: trackH)
		let trackPath = NSBezierPath(roundedRect: track, xRadius: trackH / 2, yRadius: trackH / 2)
		for (half, gradient) in [(0, ac), (1, battery)] {
			NSGraphicsContext.saveGraphicsState()
			trackPath.addClip()
			NSBezierPath(rect: 
				NSRect(x: track.minX + track.width / 2 * CGFloat(half), y: track.minY, width: track.width / 2, height: track.height)
			).addClip()
			gradient.draw(in: track, angle: -90)
			NSGraphicsContext.restoreGraphicsState()
		}
		let knobRadius = trackH * 0.38
		let knob = NSRect(
			x: track.minX + trackH * 0.10, y: track.midY - knobRadius,
			width: knobRadius * 2, height: knobRadius * 2
		)
		NSGraphicsContext.saveGraphicsState()
		let shadow = NSShadow()
		shadow.shadowBlurRadius = side * 0.02
		shadow.shadowOffset = NSSize(width: 0, height: -side * 0.006)
		shadow.set()
		NSColor.white.setFill()
		NSBezierPath(ovalIn: knob).fill()
		NSGraphicsContext.restoreGraphicsState()

	case .ribbon:
		// Battery field with an AC band slashing across it.
		fill(squircle, gradient: battery, in: rect)
		NSGraphicsContext.saveGraphicsState()
		squircle.addClip()
		let band = NSBezierPath()
		band.move(to: NSPoint(x: rect.minX, y: rect.minY + side * 0.52))
		band.line(to: NSPoint(x: rect.minX, y: rect.minY + side * 0.88))
		band.line(to: NSPoint(x: rect.maxX, y: rect.minY + side * 0.30))
		band.line(to: NSPoint(x: rect.maxX, y: rect.minY - side * 0.06))
		band.close()
		fill(band, gradient: ac, in: rect)
		NSGraphicsContext.restoreGraphicsState()
		drawGlyph("powerplug", center: NSPoint(x: rect.minX + side * 0.68, y: rect.minY + side * 0.62), width: side * 0.26)
		drawGlyph("battery.100", center: NSPoint(x: rect.minX + side * 0.32, y: rect.minY + side * 0.24), width: side * 0.30)
	}

	NSGraphicsContext.restoreGraphicsState()
	return rep
}

/// Label a grid of rendered combos so the concepts can be compared.
func writeComboSheet(to path: String) {
	let combos = Combo.allCases
	let cell: CGFloat = 220
	let labelHeight: CGFloat = 54
	let gap: CGFloat = 28
	let columns = 3
	let rows = Int((Double(combos.count) / Double(columns)).rounded(.up))
	let width = CGFloat(columns) * (cell + gap) + gap
	let height = CGFloat(rows) * (cell + labelHeight + gap) + gap

	guard
		let sheet = NSBitmapImageRep(
			bitmapDataPlanes: nil, pixelsWide: Int(width), pixelsHigh: Int(height),
			bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
			colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
		)
	else { fail("failed to allocate combo sheet") }
	sheet.size = NSSize(width: width, height: height)

	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: sheet)
	NSColor(srgbRed: 0.96, green: 0.96, blue: 0.97, alpha: 1).setFill()
	NSRect(x: 0, y: 0, width: width, height: height).fill()

	let labelStyle: [NSAttributedString.Key: Any] = [
		.font: NSFont.systemFont(ofSize: 13, weight: .medium),
		.foregroundColor: NSColor(srgbRed: 0.15, green: 0.15, blue: 0.18, alpha: 1),
	]

	for (index, combo) in combos.enumerated() {
		let column = index % columns
		let row = index / columns
		let cellLeft = gap + CGFloat(column) * (cell + gap)
		let cellTop = gap + CGFloat(row) * (cell + labelHeight + gap)
		let iconY = height - cellTop - cell
		guard let icon = renderCombo(size: cell, combo: combo) else { continue }
		icon.draw(in: NSRect(x: cellLeft, y: iconY, width: cell, height: cell))

		let label = NSAttributedString(string: combo.label, attributes: labelStyle)
		label.draw(in: NSRect(x: cellLeft - gap / 2, y: iconY - labelHeight, width: cell + gap, height: labelHeight))
	}

	NSGraphicsContext.restoreGraphicsState()

	guard let data = sheet.representation(using: .png, properties: [:]) else { fail("failed to encode combo sheet") }
	do {
		try data.write(to: URL(fileURLWithPath: path))
	} catch {
		fail("failed to write \(path): \(error)")
	}
	print("wrote \(path) with \(combos.count) combined concepts")
}

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.first == "--combos" {
	guard arguments.count >= 2 else { fail("usage: make-icon.swift --combos <out.png>") }
	writeComboSheet(to: arguments[1])
	exit(0)
}

if arguments.first == "--sheet" {
	guard arguments.count >= 2 else { fail("usage: make-icon.swift --sheet <out.png>") }
	writeSheet(to: arguments[1])
	exit(0)
}

let outDir = arguments.count > 0 ? arguments[0] : "AppIcon.iconset"
let styleKey = arguments.count > 1 ? arguments[1] : "ac"
writeIconset(to: outDir, style: style(for: styleKey))
