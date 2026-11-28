package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/png"
	"os"
	"testing"
)

// Decode every shipped representation, rather than just checking its filename.
// The small Windows variants must retain the blue mark on a transparent tile.
func TestNativeBrandIcons(t *testing.T) {
	checkApp := func(t *testing.T, data []byte, size int) image.Image {
		t.Helper()
		im, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if im.Bounds() != image.Rect(0, 0, size, size) {
			t.Fatalf("unexpected icon bounds: %v", im.Bounds())
		}
		blue, solid := 0, 0
		for y := 0; y < size; y++ {
			for x := 0; x < size; x++ {
				r, g, b, a := im.At(x, y).RGBA()
				if a > 0xf000 {
					solid++
					if b > r+0x2000 && b > g+0x1000 {
						blue++
					}
				}
			}
		}
		if solid < size*size/3 || blue < size*size/10 {
			t.Fatalf("missing opaque tile or blue brand mark: solid=%d blue=%d", solid, blue)
		}
		for _, pt := range []image.Point{{0, 0}, {size - 1, 0}, {0, size - 1}, {size - 1, size - 1}} {
			if _, _, _, a := im.At(pt.X, pt.Y).RGBA(); a != 0 {
				t.Fatal("non-transparent outer corner")
			}
		}
		return im
	}
	t.Run("app PNG", func(t *testing.T) { checkApp(t, appIcon, 1024) })
	t.Run("macOS menu template", func(t *testing.T) {
		im, err := png.Decode(bytes.NewReader(trayTemplateIcon))
		if err != nil {
			t.Fatal(err)
		}
		if im.Bounds() != image.Rect(0, 0, 64, 64) {
			t.Fatalf("unexpected template bounds: %v", im.Bounds())
		}
		opaque, clear := 0, 0
		for y := 0; y < 64; y++ {
			for x := 0; x < 64; x++ {
				r, g, b, a := im.At(x, y).RGBA()
				if r != 0 || g != 0 || b != 0 {
					t.Fatal("template contains non-black visible pixels")
				}
				if a == 0 {
					clear++
				} else if a == 0xffff {
					opaque++
				}
				if (x == 0 || y == 0 || x == 63 || y == 63) && a != 0 {
					t.Fatal("template has no transparent margin")
				}
			}
		}
		if opaque < 512 || clear < 2048 {
			t.Fatalf("template must be a visible mark, not a filled tile: %d/%d", opaque, clear)
		}
	})
	t.Run("Windows ICO", func(t *testing.T) {
		b := windowsIcon
		if len(b) < 6 || binary.LittleEndian.Uint32(b[:4]) != 0x00010000 {
			t.Fatal("invalid ICO header")
		}
		sizes := []int{256, 128, 64, 48, 40, 32, 24, 20, 16}
		count := int(binary.LittleEndian.Uint16(b[4:6]))
		if count != len(sizes) || len(b) < 6+count*16 {
			t.Fatal("invalid ICO directory")
		}
		for i, size := range sizes {
			e := b[6+i*16 : 6+(i+1)*16]
			if int(e[0]) != size%256 || int(e[1]) != size%256 {
				t.Fatalf("unexpected ICO entry %d", i)
			}
			n, off := uint64(binary.LittleEndian.Uint32(e[8:12])), uint64(binary.LittleEndian.Uint32(e[12:16]))
			if n == 0 || off < uint64(6+count*16) || off+n > uint64(len(b)) {
				t.Fatal("invalid ICO payload bounds")
			}
			checkApp(t, b[off:off+n], size)
		}
	})
	t.Run("macOS ICNS", func(t *testing.T) {
		b, err := os.ReadFile("build/darwin/icons.icns")
		if err != nil {
			t.Fatal(err)
		}
		if len(b) < 8 || string(b[:4]) != "icns" || uint64(binary.BigEndian.Uint32(b[4:8])) != uint64(len(b)) {
			t.Fatal("invalid ICNS header")
		}
		types := map[string]int{"ic10": 1024, "ic14": 512, "ic09": 512, "ic13": 256, "ic08": 256, "ic07": 128, "ic12": 64, "ic11": 32}
		for off := 8; off < len(b); {
			if len(b)-off < 8 {
				t.Fatal("truncated ICNS header")
			}
			kind := string(b[off : off+4])
			n := uint64(binary.BigEndian.Uint32(b[off+4 : off+8]))
			if n < 8 || n > uint64(len(b)-off) {
				t.Fatal("invalid ICNS payload bounds")
			}
			size, ok := types[kind]
			if !ok {
				t.Fatalf("unexpected ICNS representation %s", kind)
			}
			checkApp(t, b[off+8:off+int(n)], size)
			delete(types, kind)
			off += int(n)
		}
		if len(types) != 0 {
			t.Fatalf("missing ICNS representations: %v", types)
		}
	})
}
