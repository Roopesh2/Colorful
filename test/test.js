CODE = `function a(_dereq_, module, exports) {
  (function (Buffer) {
    /**
     * https://opentype.js.org v0.9.0 | (c) Frederik De Bleser and other contributors | MIT License | Uses tiny-inflate by Devon Govett and string.prototype.codepointat polyfill by Mathias Bynens
     */

    (function (global, factory) {
      typeof exports === "object" && typeof module !== "undefined"
        ? factory(exports)
        : typeof define === "function" && define.amd
        ? define(["exports"], factory)
        : factory((global.opentype = {}));
    })(this, function (exports) {
      "use strict";

      /*! https://mths.be/codepointat v0.2.0 by @mathias */
      if (!String.prototype.codePointAt) {
        (function () {
          var defineProperty = (function () {
            // IE 8 only supports \`Object.defineProperty\` on DOM elements
            try {
              var object = {};
              var $defineProperty = Object.defineProperty;
              var result =
                $defineProperty(object, object, object) && $defineProperty;
            } catch (error) {}
            return result;
          })();
          var codePointAt = function (position) {
            if (this == null) {
              throw TypeError();
            }
            var string = String(this);
            var size = string.length;
            // \`ToInteger\`
            var index = position ? Number(position) : 0;
            if (index != index) {
              // better \`isNaN\`
              index = 0;
            }
            // Account for out-of-bounds indices:
            if (index < 0 || index >= size) {
              return undefined;
            }
            // Get the first code unit
            var first = string.charCodeAt(index);
            var second;
            if (
              // check if it’s the start of a surrogate pair
              first >= 0xd800 &&
              first <= 0xdbff && // high surrogate
              size > index + 1 // there is a next code unit
            ) {
              second = string.charCodeAt(index + 1);
              if (second >= 0xdc00 && second <= 0xdfff) {
                // low surrogate
                // https://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
                return (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
              }
            }
            return first;
          };
          if (defineProperty) {
            defineProperty(String.prototype, "codePointAt", {
              value: codePointAt,
              configurable: true,
              writable: true,
            });
          } else {
            String.prototype.codePointAt = codePointAt;
          }
        })();
      }

      var TINF_OK = 0;
      var TINF_DATA_ERROR = -3;

      function Tree() {
        this.table = new Uint16Array(16); /* table of code length counts */
        this.trans = new Uint16Array(
          288
        ); /* code -> symbol translation table */
      }

      function Data(source, dest) {
        this.source = source;
        this.sourceIndex = 0;
        this.tag = 0;
        this.bitcount = 0;

        this.dest = dest;
        this.destLen = 0;

        this.ltree = new Tree(); /* dynamic length/symbol tree */
        this.dtree = new Tree(); /* dynamic distance tree */
      }

      /* --------------------------------------------------- *
       * -- uninitialized global data (static structures) -- *
       * --------------------------------------------------- */

      var sltree = new Tree();
      var sdtree = new Tree();

      /* extra bits and base tables for length codes */
      var length_bits = new Uint8Array(30);
      var length_base = new Uint16Array(30);

      /* extra bits and base tables for distance codes */
      var dist_bits = new Uint8Array(30);
      var dist_base = new Uint16Array(30);

      /* special ordering of code length codes */
      var clcidx = new Uint8Array([
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
      ]);

      /* used by tinf_decode_trees, avoids allocations every call */
      var code_tree = new Tree();
      var lengths = new Uint8Array(288 + 32);

      /* ----------------------- *
       * -- utility functions -- *
       * ----------------------- */

      /* build extra bits and base tables */
      function tinf_build_bits_base(bits, base, delta, first) {
        var i, sum;

        /* build bits table */
        for (i = 0; i < delta; ++i) {
          bits[i] = 0;
        }
        for (i = 0; i < 30 - delta; ++i) {
          bits[i + delta] = (i / delta) | 0;
        }

        /* build base table */
        for (sum = first, i = 0; i < 30; ++i) {
          base[i] = sum;
          sum += 1 << bits[i];
        }
      }

      /* build the fixed huffman trees */
      function tinf_build_fixed_trees(lt, dt) {
        var i;

        /* build fixed length tree */
        for (i = 0; i < 7; ++i) {
          lt.table[i] = 0;
        }

        lt.table[7] = 24;
        lt.table[8] = 152;
        lt.table[9] = 112;

        for (i = 0; i < 24; ++i) {
          lt.trans[i] = 256 + i;
        }
        for (i = 0; i < 144; ++i) {
          lt.trans[24 + i] = i;
        }
        for (i = 0; i < 8; ++i) {
          lt.trans[24 + 144 + i] = 280 + i;
        }
        for (i = 0; i < 112; ++i) {
          lt.trans[24 + 144 + 8 + i] = 144 + i;
        }

        /* build fixed distance tree */
        for (i = 0; i < 5; ++i) {
          dt.table[i] = 0;
        }

        dt.table[5] = 32;

        for (i = 0; i < 32; ++i) {
          dt.trans[i] = i;
        }
      }

      /* given an array of code lengths, build a tree */
      var offs = new Uint16Array(16);

      function tinf_build_tree(t, lengths, off, num) {
        var i, sum;

        /* clear code length count table */
        for (i = 0; i < 16; ++i) {
          t.table[i] = 0;
        }

        /* scan symbol lengths, and sum code length counts */
        for (i = 0; i < num; ++i) {
          t.table[lengths[off + i]]++;
        }

        t.table[0] = 0;

        /* compute offset table for distribution sort */
        for (sum = 0, i = 0; i < 16; ++i) {
          offs[i] = sum;
          sum += t.table[i];
        }

        /* create code->symbol translation table (symbols sorted by code) */
        for (i = 0; i < num; ++i) {
          if (lengths[off + i]) {
            t.trans[offs[lengths[off + i]]++] = i;
          }
        }
      }

      /* ---------------------- *
       * -- decode functions -- *
       * ---------------------- */

      /* get one bit from source stream */
      function tinf_getbit(d) {
        /* check if tag is empty */
        if (!d.bitcount--) {
          /* load next tag */
          d.tag = d.source[d.sourceIndex++];
          d.bitcount = 7;
        }

        /* shift bit out of tag */
        var bit = d.tag & 1;
        d.tag >>>= 1;

        return bit;
      }

      /* read a num bit value from a stream and add base */
      function tinf_read_bits(d, num, base) {
        if (!num) {
          return base;
        }

        while (d.bitcount < 24) {
          d.tag |= d.source[d.sourceIndex++] << d.bitcount;
          d.bitcount += 8;
        }

        var val = d.tag & (0xffff >>> (16 - num));
        d.tag >>>= num;
        d.bitcount -= num;
        return val + base;
      }

      /* given a data stream and a tree, decode a symbol */
      function tinf_decode_symbol(d, t) {
        while (d.bitcount < 24) {
          d.tag |= d.source[d.sourceIndex++] << d.bitcount;
          d.bitcount += 8;
        }

        var sum = 0,
          cur = 0,
          len = 0;
        var tag = d.tag;

        /* get more bits while code value is above sum */
        do {
          cur = 2 * cur + (tag & 1);
          tag >>>= 1;
          ++len;

          sum += t.table[len];
          cur -= t.table[len];
        } while (cur >= 0);

        d.tag = tag;
        d.bitcount -= len;

        return t.trans[sum + cur];
      }

      /* given a data stream, decode dynamic trees from it */
      function tinf_decode_trees(d, lt, dt) {
        var hlit, hdist, hclen;
        var i, num, length;

        /* get 5 bits HLIT (257-286) */
        hlit = tinf_read_bits(d, 5, 257);

        /* get 5 bits HDIST (1-32) */
        hdist = tinf_read_bits(d, 5, 1);

        /* get 4 bits HCLEN (4-19) */
        hclen = tinf_read_bits(d, 4, 4);

        for (i = 0; i < 19; ++i) {
          lengths[i] = 0;
        }

        /* read code lengths for code length alphabet */
        for (i = 0; i < hclen; ++i) {
          /* get 3 bits code length (0-7) */
          var clen = tinf_read_bits(d, 3, 0);
          lengths[clcidx[i]] = clen;
        }

        /* build code length tree */
        tinf_build_tree(code_tree, lengths, 0, 19);

        /* decode code lengths for the dynamic trees */
        for (num = 0; num < hlit + hdist; ) {
          var sym = tinf_decode_symbol(d, code_tree);

          switch (sym) {
            case 16:
              /* copy previous code length 3-6 times (read 2 bits) */
              var prev = lengths[num - 1];
              for (length = tinf_read_bits(d, 2, 3); length; --length) {
                lengths[num++] = prev;
              }
              break;
            case 17:
              /* repeat code length 0 for 3-10 times (read 3 bits) */
              for (length = tinf_read_bits(d, 3, 3); length; --length) {
                lengths[num++] = 0;
              }
              break;
            case 18:
              /* repeat code length 0 for 11-138 times (read 7 bits) */
              for (length = tinf_read_bits(d, 7, 11); length; --length) {
                lengths[num++] = 0;
              }
              break;
            default:
              /* values 0-15 represent the actual code lengths */
              lengths[num++] = sym;
              break;
          }
        }

        /* build dynamic trees */
        tinf_build_tree(lt, lengths, 0, hlit);
        tinf_build_tree(dt, lengths, hlit, hdist);
      }

      /* ----------------------------- *
       * -- block inflate functions -- *
       * ----------------------------- */

      /* given a stream and two trees, inflate a block of data */
      function tinf_inflate_block_data(d, lt, dt) {
        while (1) {
          var sym = tinf_decode_symbol(d, lt);

          /* check for end of block */
          if (sym === 256) {
            return TINF_OK;
          }

          if (sym < 256) {
            d.dest[d.destLen++] = sym;
          } else {
            var length, dist, offs;
            var i;

            sym -= 257;

            /* possibly get more bits from length code */
            length = tinf_read_bits(d, length_bits[sym], length_base[sym]);

            dist = tinf_decode_symbol(d, dt);

            /* possibly get more bits from distance code */
            offs =
              d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);

            /* copy match */
            for (i = offs; i < offs + length; ++i) {
              d.dest[d.destLen++] = d.dest[i];
            }
          }
        }
      }

      /* inflate an uncompressed block of data */
      function tinf_inflate_uncompressed_block(d) {
        var length, invlength;
        var i;

        /* unread from bitbuffer */
        while (d.bitcount > 8) {
          d.sourceIndex--;
          d.bitcount -= 8;
        }

        /* get length */
        length = d.source[d.sourceIndex + 1];
        length = 256 * length + d.source[d.sourceIndex];

        /* get one's complement of length */
        invlength = d.source[d.sourceIndex + 3];
        invlength = 256 * invlength + d.source[d.sourceIndex + 2];

        /* check length */
        if (length !== (~invlength & 0x0000ffff)) {
          return TINF_DATA_ERROR;
        }

        d.sourceIndex += 4;

        /* copy block */
        for (i = length; i; --i) {
          d.dest[d.destLen++] = d.source[d.sourceIndex++];
        }

        /* make sure we start next block on a byte boundary */
        d.bitcount = 0;

        return TINF_OK;
      }

      /* inflate stream from source to dest */
      function tinf_uncompress(source, dest) {
        var d = new Data(source, dest);
        var bfinal, btype, res;

        do {
          /* read final block flag */
          bfinal = tinf_getbit(d);

          /* read block type (2 bits) */
          btype = tinf_read_bits(d, 2, 0);

          /* decompress block */
          switch (btype) {
            case 0:
              /* decompress uncompressed block */
              res = tinf_inflate_uncompressed_block(d);
              break;
            case 1:
              /* decompress block with fixed huffman trees */
              res = tinf_inflate_block_data(d, sltree, sdtree);
              break;
            case 2:
              /* decompress block with dynamic huffman trees */
              tinf_decode_trees(d, d.ltree, d.dtree);
              res = tinf_inflate_block_data(d, d.ltree, d.dtree);
              break;
            default:
              res = TINF_DATA_ERROR;
          }

          if (res !== TINF_OK) {
            throw new Error("Data error");
          }
        } while (!bfinal);

        if (d.destLen < d.dest.length) {
          if (typeof d.dest.slice === "function") {
            return d.dest.slice(0, d.destLen);
          } else {
            return d.dest.subarray(0, d.destLen);
          }
        }

        return d.dest;
      }

      /* -------------------- *
       * -- initialization -- *
       * -------------------- */

      /* build fixed huffman trees */
      tinf_build_fixed_trees(sltree, sdtree);

      /* build extra bits and base tables */
      tinf_build_bits_base(length_bits, length_base, 4, 3);
      tinf_build_bits_base(dist_bits, dist_base, 2, 1);

      /* fix a special case */
      length_bits[28] = 0;
      length_base[28] = 258;

      var tinyInflate = tinf_uncompress;

      // The Bounding Box object

      function derive(v0, v1, v2, v3, t) {
        return (
          Math.pow(1 - t, 3) * v0 +
          3 * Math.pow(1 - t, 2) * t * v1 +
          3 * (1 - t) * Math.pow(t, 2) * v2 +
          Math.pow(t, 3) * v3
        );
      }
      /**
       * A bounding box is an enclosing box that describes the smallest measure within which all the points lie.
       * It is used to calculate the bounding box of a glyph or text path.
       *
       * On initialization, x1/y1/x2/y2 will be NaN. Check if the bounding box is empty using \`isEmpty()\`.
       *
       * @exports opentype.BoundingBox
       * @class
       * @constructor
       */
      function BoundingBox() {
        this.x1 = Number.NaN;
        this.y1 = Number.NaN;
        this.x2 = Number.NaN;
        this.y2 = Number.NaN;
      }

      /**
       * Returns true if the bounding box is empty, that is, no points have been added to the box yet.
       */
      BoundingBox.prototype.isEmpty = function () {
        return (
          isNaN(this.x1) || isNaN(this.y1) || isNaN(this.x2) || isNaN(this.y2)
        );
      };

      /**
       * Add the point to the bounding box.
       * The x1/y1/x2/y2 coordinates of the bounding box will now encompass the given point.
       * @param {number} x - The X coordinate of the point.
       * @param {number} y - The Y coordinate of the point.
       */
      BoundingBox.prototype.addPoint = function (x, y) {
        if (typeof x === "number") {
          if (isNaN(this.x1) || isNaN(this.x2)) {
            this.x1 = x;
            this.x2 = x;
          }
          if (x < this.x1) {
            this.x1 = x;
          }
          if (x > this.x2) {
            this.x2 = x;
          }
        }
        if (typeof y === "number") {
          if (isNaN(this.y1) || isNaN(this.y2)) {
            this.y1 = y;
            this.y2 = y;
          }
          if (y < this.y1) {
            this.y1 = y;
          }
          if (y > this.y2) {
            this.y2 = y;
          }
        }
      };

      /**
       * Add a X coordinate to the bounding box.
       * This extends the bounding box to include the X coordinate.
       * This function is used internally inside of addBezier.
       * @param {number} x - The X coordinate of the point.
       */
      BoundingBox.prototype.addX = function (x) {
        this.addPoint(x, null);
      };

      /**
       * Add a Y coordinate to the bounding box.
       * This extends the bounding box to include the Y coordinate.
       * This function is used internally inside of addBezier.
       * @param {number} y - The Y coordinate of the point.
       */
      BoundingBox.prototype.addY = function (y) {
        this.addPoint(null, y);
      };

      /**
       * Add a Bézier curve to the bounding box.
       * This extends the bounding box to include the entire Bézier.
       * @param {number} x0 - The starting X coordinate.
       * @param {number} y0 - The starting Y coordinate.
       * @param {number} x1 - The X coordinate of the first control point.
       * @param {number} y1 - The Y coordinate of the first control point.
       * @param {number} x2 - The X coordinate of the second control point.
       * @param {number} y2 - The Y coordinate of the second control point.
       * @param {number} x - The ending X coordinate.
       * @param {number} y - The ending Y coordinate.
       */
      BoundingBox.prototype.addBezier = function (
        x0,
        y0,
        x1,
        y1,
        x2,
        y2,
        x,
        y
      ) {
        var this$1 = this;

        // This code is based on http://nishiohirokazu.blogspot.com/2009/06/how-to-calculate-bezier-curves-bounding.html
        // and https://github.com/icons8/svg-path-bounding-box

        var p0 = [x0, y0];
        var p1 = [x1, y1];
        var p2 = [x2, y2];
        var p3 = [x, y];

        this.addPoint(x0, y0);
        this.addPoint(x, y);

        for (var i = 0; i <= 1; i++) {
          var b = 6 * p0[i] - 12 * p1[i] + 6 * p2[i];
          var a = -3 * p0[i] + 9 * p1[i] - 9 * p2[i] + 3 * p3[i];
          var c = 3 * p1[i] - 3 * p0[i];

          if (a === 0) {
            if (b === 0) {
              continue;
            }
            var t = -c / b;
            if (0 < t && t < 1) {
              if (i === 0) {
                this$1.addX(derive(p0[i], p1[i], p2[i], p3[i], t));
              }
              if (i === 1) {
                this$1.addY(derive(p0[i], p1[i], p2[i], p3[i], t));
              }
            }
            continue;
          }

          var b2ac = Math.pow(b, 2) - 4 * c * a;
          if (b2ac < 0) {
            continue;
          }
          var t1 = (-b + Math.sqrt(b2ac)) / (2 * a);
          if (0 < t1 && t1 < 1) {
            if (i === 0) {
              this$1.addX(derive(p0[i], p1[i], p2[i], p3[i], t1));
            }
            if (i === 1) {
              this$1.addY(derive(p0[i], p1[i], p2[i], p3[i], t1));
            }
          }
          var t2 = (-b - Math.sqrt(b2ac)) / (2 * a);
          if (0 < t2 && t2 < 1) {
            if (i === 0) {
              this$1.addX(derive(p0[i], p1[i], p2[i], p3[i], t2));
            }
            if (i === 1) {
              this$1.addY(derive(p0[i], p1[i], p2[i], p3[i], t2));
            }
          }
        }
      };

      /**
       * Add a quadratic curve to the bounding box.
       * This extends the bounding box to include the entire quadratic curve.
       * @param {number} x0 - The starting X coordinate.
       * @param {number} y0 - The starting Y coordinate.
       * @param {number} x1 - The X coordinate of the control point.
       * @param {number} y1 - The Y coordinate of the control point.
       * @param {number} x - The ending X coordinate.
       * @param {number} y - The ending Y coordinate.
       */
      BoundingBox.prototype.addQuad = function (x0, y0, x1, y1, x, y) {
        var cp1x = x0 + (2 / 3) * (x1 - x0);
        var cp1y = y0 + (2 / 3) * (y1 - y0);
        var cp2x = cp1x + (1 / 3) * (x - x0);
        var cp2y = cp1y + (1 / 3) * (y - y0);
        this.addBezier(x0, y0, cp1x, cp1y, cp2x, cp2y, x, y);
      };

      // Geometric objects

      /**
       * A bézier path containing a set of path commands similar to a SVG path.
       * Paths can be drawn on a context using \`draw\`.
       * @exports opentype.Path
       * @class
       * @constructor
       */
      function Path() {
        this.commands = [];
        this.fill = "black";
        this.stroke = null;
        this.strokeWidth = 1;
      }

      /**
       * @param  {number} x
       * @param  {number} y
       */
      Path.prototype.moveTo = function (x, y) {
        this.commands.push({
          type: "M",
          x: x,
          y: y,
        });
      };

      /**
       * @param  {number} x
       * @param  {number} y
       */
      Path.prototype.lineTo = function (x, y) {
        this.commands.push({
          type: "L",
          x: x,
          y: y,
        });
      };

      /**
       * Draws cubic curve
       * @function
       * curveTo
       * @memberof opentype.Path.prototype
       * @param  {number} x1 - x of control 1
       * @param  {number} y1 - y of control 1
       * @param  {number} x2 - x of control 2
       * @param  {number} y2 - y of control 2
       * @param  {number} x - x of path point
       * @param  {number} y - y of path point
       */

      /**
       * Draws cubic curve
       * @function
       * bezierCurveTo
       * @memberof opentype.Path.prototype
       * @param  {number} x1 - x of control 1
       * @param  {number} y1 - y of control 1
       * @param  {number} x2 - x of control 2
       * @param  {number} y2 - y of control 2
       * @param  {number} x - x of path point
       * @param  {number} y - y of path point
       * @see curveTo
       */
      Path.prototype.curveTo = Path.prototype.bezierCurveTo = function (
        x1,
        y1,
        x2,
        y2,
        x,
        y
      ) {
        this.commands.push({
          type: "C",
          x1: x1,
          y1: y1,
          x2: x2,
          y2: y2,
          x: x,
          y: y,
        });
      };

      /**
       * Draws quadratic curve
       * @function
       * quadraticCurveTo
       * @memberof opentype.Path.prototype
       * @param  {number} x1 - x of control
       * @param  {number} y1 - y of control
       * @param  {number} x - x of path point
       * @param  {number} y - y of path point
       */

      /**
       * Draws quadratic curve
       * @function
       * quadTo
       * @memberof opentype.Path.prototype
       * @param  {number} x1 - x of control
       * @param  {number} y1 - y of control
       * @param  {number} x - x of path point
       * @param  {number} y - y of path point
       */
      Path.prototype.quadTo = Path.prototype.quadraticCurveTo = function (
        x1,
        y1,
        x,
        y
      ) {
        this.commands.push({
          type: "Q",
          x1: x1,
          y1: y1,
          x: x,
          y: y,
        });
      };

      /**
       * Closes the path
       * @function closePath
       * @memberof opentype.Path.prototype
       */

      /**
       * Close the path
       * @function close
       * @memberof opentype.Path.prototype
       */
      Path.prototype.close = Path.prototype.closePath = function () {
        this.commands.push({
          type: "Z",
        });
      };

      /**
       * Add the given path or list of commands to the commands of this path.
       * @param  {Array} pathOrCommands - another opentype.Path, an opentype.BoundingBox, or an array of commands.
       */
      Path.prototype.extend = function (pathOrCommands) {
        if (pathOrCommands.commands) {
          pathOrCommands = pathOrCommands.commands;
        } else if (pathOrCommands instanceof BoundingBox) {
          var box = pathOrCommands;
          this.moveTo(box.x1, box.y1);
          this.lineTo(box.x2, box.y1);
          this.lineTo(box.x2, box.y2);
          this.lineTo(box.x1, box.y2);
          this.close();
          return;
        }

        Array.prototype.push.apply(this.commands, pathOrCommands);
      };

      /**
       * Calculate the bounding box of the path.
       * @returns {opentype.BoundingBox}
       */
      Path.prototype.getBoundingBox = function () {
        var this$1 = this;

        var box = new BoundingBox();

        var startX = 0;
        var startY = 0;
        var prevX = 0;
        var prevY = 0;
        for (var i = 0; i < this.commands.length; i++) {
          var cmd = this$1.commands[i];
          switch (cmd.type) {
            case "M":
              box.addPoint(cmd.x, cmd.y);
              startX = prevX = cmd.x;
              startY = prevY = cmd.y;
              break;
            case "L":
              box.addPoint(cmd.x, cmd.y);
              prevX = cmd.x;
              prevY = cmd.y;
              break;
            case "Q":
              box.addQuad(prevX, prevY, cmd.x1, cmd.y1, cmd.x, cmd.y);
              prevX = cmd.x;
              prevY = cmd.y;
              break;
            case "C":
              box.addBezier(
                prevX,
                prevY,
                cmd.x1,
                cmd.y1,
                cmd.x2,
                cmd.y2,
                cmd.x,
                cmd.y
              );
              prevX = cmd.x;
              prevY = cmd.y;
              break;
            case "Z":
              prevX = startX;
              prevY = startY;
              break;
            default:
              throw new Error("Unexpected path command " + cmd.type);
          }
        }
        if (box.isEmpty()) {
          box.addPoint(0, 0);
        }
        return box;
      };

      /**
       * Draw the path to a 2D context.
       * @param {CanvasRenderingContext2D} ctx - A 2D drawing context.
       */
      Path.prototype.draw = function (ctx) {
        var this$1 = this;

        ctx.beginPath();
        for (var i = 0; i < this.commands.length; i += 1) {
          var cmd = this$1.commands[i];
          if (cmd.type === "M") {
            ctx.moveTo(cmd.x, cmd.y);
          } else if (cmd.type === "L") {
            ctx.lineTo(cmd.x, cmd.y);
          } else if (cmd.type === "C") {
            ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          } else if (cmd.type === "Q") {
            ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y);
          } else if (cmd.type === "Z") {
            ctx.closePath();
          }
        }

        if (this.fill) {
          ctx.fillStyle = this.fill;
          ctx.fill();
        }

        if (this.stroke) {
          ctx.strokeStyle = this.stroke;
          ctx.lineWidth = this.strokeWidth;
          ctx.stroke();
        }
      };

      /**
       * Convert the Path to a string of path data instructions
       * See http://www.w3.org/TR/SVG/paths.html#PathData
       * @param  {number} [decimalPlaces=2] - The amount of decimal places for floating-point values
       * @return {string}
       */
      Path.prototype.toPathData = function (decimalPlaces) {
        var this$1 = this;

        decimalPlaces = decimalPlaces !== undefined ? decimalPlaces : 2;

        function floatToString(v) {
          if (Math.round(v) === v) {
            return "" + Math.round(v);
          } else {
            return v.toFixed(decimalPlaces);
          }
        }

        function packValues() {
          var arguments$1 = arguments;

          var s = "";
          for (var i = 0; i < arguments.length; i += 1) {
            var v = arguments$1[i];
            if (v >= 0 && i > 0) {
              s += " ";
            }

            s += floatToString(v);
          }

          return s;
        }

        var d = "";
        for (var i = 0; i < this.commands.length; i += 1) {
          var cmd = this$1.commands[i];
          if (cmd.type === "M") {
            d += "M" + packValues(cmd.x, cmd.y);
          } else if (cmd.type === "L") {
            d += "L" + packValues(cmd.x, cmd.y);
          } else if (cmd.type === "C") {
            d += "C" + packValues(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          } else if (cmd.type === "Q") {
            d += "Q" + packValues(cmd.x1, cmd.y1, cmd.x, cmd.y);
          } else if (cmd.type === "Z") {
            d += "Z";
          }
        }

        return d;
      };

      /**
       * Convert the path to an SVG <path> element, as a string.
       * @param  {number} [decimalPlaces=2] - The amount of decimal places for floating-point values
       * @return {string}
       */
      Path.prototype.toSVG = function (decimalPlaces) {
        var svg = '<path d="';
        svg += this.toPathData(decimalPlaces);
        svg += '"';
        if (this.fill && this.fill !== "black") {
          if (this.fill === null) {
            svg += ' fill="none"';
          } else {
            svg += ' fill="' + this.fill + '"';
          }
        }

        if (this.stroke) {
          svg +=
            ' stroke="' +
            this.stroke +
            '" stroke-width="' +
            this.strokeWidth +
            '"';
        }

        svg += "/>";
        return svg;
      };

      /**
       * Convert the path to a DOM element.
       * @param  {number} [decimalPlaces=2] - The amount of decimal places for floating-point values
       * @return {SVGPathElement}
       */
      Path.prototype.toDOMElement = function (decimalPlaces) {
        var temporaryPath = this.toPathData(decimalPlaces);
        var newPath = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path"
        );

        newPath.setAttribute("d", temporaryPath);

        return newPath;
      };

      // Run-time checking of preconditions.

      function fail(message) {
        throw new Error(message);
      }

      // Precondition function that checks if the given predicate is true.
      // If not, it will throw an error.
      function argument(predicate, message) {
        if (!predicate) {
          fail(message);
        }
      }
      var check = { fail: fail, argument: argument, assert: argument };

      // Data types used in the OpenType font file.

      var LIMIT16 = 32768; // The limit at which a 16-bit number switches signs == 2^15
      var LIMIT32 = 2147483648; // The limit at which a 32-bit number switches signs == 2 ^ 31

      /**
       * @exports opentype.decode
       * @class
       */
      var decode = {};
      /**
       * @exports opentype.encode
       * @class
       */
      var encode = {};
      /**
       * @exports opentype.sizeOf
       * @class
       */
      var sizeOf = {};

      // Return a function that always returns the same value.
      function constant(v) {
        return function () {
          return v;
        };
      }

      // OpenType data types //////////////////////////////////////////////////////

      /**
       * Convert an 8-bit unsigned integer to a list of 1 byte.
       * @param {number}
       * @returns {Array}
       */
      encode.BYTE = function (v) {
        check.argument(
          v >= 0 && v <= 255,
          "Byte value should be between 0 and 255."
        );
        return [v];
      };
      /**
       * @constant
       * @type {number}
       */
      sizeOf.BYTE = constant(1);

      /**
       * Convert a 8-bit signed integer to a list of 1 byte.
       * @param {string}
       * @returns {Array}
       */
      encode.CHAR = function (v) {
        return [v.charCodeAt(0)];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.CHAR = constant(1);

      /**
       * Convert an ASCII string to a list of bytes.
       * @param {string}
       * @returns {Array}
       */
      encode.CHARARRAY = function (v) {
        var b = [];
        for (var i = 0; i < v.length; i += 1) {
          b[i] = v.charCodeAt(i);
        }

        return b;
      };

      /**
       * @param {Array}
       * @returns {number}
       */
      sizeOf.CHARARRAY = function (v) {
        return v.length;
      };

      /**
       * Convert a 16-bit unsigned integer to a list of 2 bytes.
       * @param {number}
       * @returns {Array}
       */
      encode.USHORT = function (v) {
        return [(v >> 8) & 0xff, v & 0xff];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.USHORT = constant(2);

      /**
       * Convert a 16-bit signed integer to a list of 2 bytes.
       * @param {number}
       * @returns {Array}
       */
      encode.SHORT = function (v) {
        // Two's complement
        if (v >= LIMIT16) {
          v = -(2 * LIMIT16 - v);
        }

        return [(v >> 8) & 0xff, v & 0xff];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.SHORT = constant(2);

      /**
       * Convert a 24-bit unsigned integer to a list of 3 bytes.
       * @param {number}
       * @returns {Array}
       */
      encode.UINT24 = function (v) {
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.UINT24 = constant(3);

      /**
       * Convert a 32-bit unsigned integer to a list of 4 bytes.
       * @param {number}
       * @returns {Array}
       */
      encode.ULONG = function (v) {
        return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.ULONG = constant(4);

      /**
       * Convert a 32-bit unsigned integer to a list of 4 bytes.
       * @param {number}
       * @returns {Array}
       */
      encode.LONG = function (v) {
        // Two's complement
        if (v >= LIMIT32) {
          v = -(2 * LIMIT32 - v);
        }

        return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.LONG = constant(4);

      encode.FIXED = encode.ULONG;
      sizeOf.FIXED = sizeOf.ULONG;

      encode.FWORD = encode.SHORT;
      sizeOf.FWORD = sizeOf.SHORT;

      encode.UFWORD = encode.USHORT;
      sizeOf.UFWORD = sizeOf.USHORT;

      /**
       * Convert a 32-bit Apple Mac timestamp integer to a list of 8 bytes, 64-bit timestamp.
       * @param {number}
       * @returns {Array}
       */
      encode.LONGDATETIME = function (v) {
        return [
          0,
          0,
          0,
          0,
          (v >> 24) & 0xff,
          (v >> 16) & 0xff,
          (v >> 8) & 0xff,
          v & 0xff,
        ];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.LONGDATETIME = constant(8);

      /**
       * Convert a 4-char tag to a list of 4 bytes.
       * @param {string}
       * @returns {Array}
       */
      encode.TAG = function (v) {
        check.argument(
          v.length === 4,
          "Tag should be exactly 4 ASCII characters."
        );
        return [
          v.charCodeAt(0),
          v.charCodeAt(1),
          v.charCodeAt(2),
          v.charCodeAt(3),
        ];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.TAG = constant(4);

      // CFF data types ///////////////////////////////////////////////////////////

      encode.Card8 = encode.BYTE;
      sizeOf.Card8 = sizeOf.BYTE;

      encode.Card16 = encode.USHORT;
      sizeOf.Card16 = sizeOf.USHORT;

      encode.OffSize = encode.BYTE;
      sizeOf.OffSize = sizeOf.BYTE;

      encode.SID = encode.USHORT;
      sizeOf.SID = sizeOf.USHORT;

      // Convert a numeric operand or charstring number to a variable-size list of bytes.
      /**
       * Convert a numeric operand or charstring number to a variable-size list of bytes.
       * @param {number}
       * @returns {Array}
       */
      encode.NUMBER = function (v) {
        if (v >= -107 && v <= 107) {
          return [v + 139];
        } else if (v >= 108 && v <= 1131) {
          v = v - 108;
          return [(v >> 8) + 247, v & 0xff];
        } else if (v >= -1131 && v <= -108) {
          v = -v - 108;
          return [(v >> 8) + 251, v & 0xff];
        } else if (v >= -32768 && v <= 32767) {
          return encode.NUMBER16(v);
        } else {
          return encode.NUMBER32(v);
        }
      };

      /**
       * @param {number}
       * @returns {number}
       */
      sizeOf.NUMBER = function (v) {
        return encode.NUMBER(v).length;
      };

      /**
       * Convert a signed number between -32768 and +32767 to a three-byte value.
       * This ensures we always use three bytes, but is not the most compact format.
       * @param {number}
       * @returns {Array}
       */
      encode.NUMBER16 = function (v) {
        return [28, (v >> 8) & 0xff, v & 0xff];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.NUMBER16 = constant(3);

      /**
       * Convert a signed number between -(2^31) and +(2^31-1) to a five-byte value.
       * This is useful if you want to be sure you always use four bytes,
       * at the expense of wasting a few bytes for smaller numbers.
       * @param {number}
       * @returns {Array}
       */
      encode.NUMBER32 = function (v) {
        return [
          29,
          (v >> 24) & 0xff,
          (v >> 16) & 0xff,
          (v >> 8) & 0xff,
          v & 0xff,
        ];
      };

      /**
       * @constant
       * @type {number}
       */
      sizeOf.NUMBER32 = constant(5);

      /**
       * @param {number}
       * @returns {Array}
       */
      encode.REAL = function (v) {
        var value = v.toString();

        // Some numbers use an epsilon to encode the value. (e.g. JavaScript will store 0.0000001 as 1e-7)
        // This code converts it back to a number without the epsilon.
        var m = /\\.(\\d*?)(?:9{5,20}|0{5,20})\\d{0,2}(?:e(.+)|$)/.exec(value);
        if (m) {
          var epsilon = parseFloat("1e" + ((m[2] ? +m[2] : 0) + m[1].length));
          value = (Math.round(v * epsilon) / epsilon).toString();
        }

        var nibbles = "";
        for (var i = 0, ii = value.length; i < ii; i += 1) {
          var c = value[i];
          if (c === "e") {
            nibbles += value[++i] === "-" ? "c" : "b";
          } else if (c === ".") {
            nibbles += "a";
          } else if (c === "-") {
            nibbles += "e";
          } else {
            nibbles += c;
          }
        }

        nibbles += nibbles.length & 1 ? "f" : "ff";
        var out = [30];
        for (var i$1 = 0, ii$1 = nibbles.length; i$1 < ii$1; i$1 += 2) {
          out.push(parseInt(nibbles.substr(i$1, 2), 16));
        }

        return out;
      };

      /**
       * @param {number}
       * @returns {number}
       */
      sizeOf.REAL = function (v) {
        return encode.REAL(v).length;
      };

      encode.NAME = encode.CHARARRAY;
      sizeOf.NAME = sizeOf.CHARARRAY;

      encode.STRING = encode.CHARARRAY;
      sizeOf.STRING = sizeOf.CHARARRAY;

      /**
       * @param {DataView} data
       * @param {number} offset
       * @param {number} numBytes
       * @returns {string}
       */
      decode.UTF8 = function (data, offset, numBytes) {
        var codePoints = [];
        var numChars = numBytes;
        for (var j = 0; j < numChars; j++, offset += 1) {
          codePoints[j] = data.getUint8(offset);
        }

        return String.fromCharCode.apply(null, codePoints);
      };

      /**
       * @param {DataView} data
       * @param {number} offset
       * @param {number} numBytes
       * @returns {string}
       */
      decode.UTF16 = function (data, offset, numBytes) {
        var codePoints = [];
        var numChars = numBytes / 2;
        for (var j = 0; j < numChars; j++, offset += 2) {
          codePoints[j] = data.getUint16(offset);
        }

        return String.fromCharCode.apply(null, codePoints);
      };

      /**
       * Convert a JavaScript string to UTF16-BE.
       * @param {string}
       * @returns {Array}
       */
      encode.UTF16 = function (v) {
        var b = [];
        for (var i = 0; i < v.length; i += 1) {
          var codepoint = v.charCodeAt(i);
          b[b.length] = (codepoint >> 8) & 0xff;
          b[b.length] = codepoint & 0xff;
        }

        return b;
      };

      /**
       * @param {string}
       * @returns {number}
       */
      sizeOf.UTF16 = function (v) {
        return v.length * 2;
      };

      // Data for converting old eight-bit Macintosh encodings to Unicode.
      // This representation is optimized for decoding; encoding is slower
      // and needs more memory. The assumption is that all opentype.js users
      // want to open fonts, but saving a font will be comparatively rare
      // so it can be more expensive. Keyed by IANA character set name.
      //
      // Python script for generating these strings:
      //
      //	 s = u''.join([chr(c).decode('mac_greek') for c in range(128, 256)])
      //	 print(s.encode('utf-8'))
      /**
       * @private
       */
      var eightBitMacEncodings = {
        // Python: 'mac_croatian'
        "x-mac-croatian":
          "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®Š™´¨≠ŽØ∞±≤≥∆µ∂∑∏š∫ªºΩžø" +
          "¿¡¬√ƒ≈Ć«Č… ÀÃÕŒœĐ—“”‘’÷◊©⁄€‹›Æ»–·‚„‰ÂćÁčÈÍÎÏÌÓÔđÒÚÛÙıˆ˜¯πË˚¸Êæˇ",
        // Python: 'mac_cyrillic'
        "x-mac-cyrillic":
          "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ†°Ґ£§•¶І®©™Ђђ≠Ѓѓ∞±≤≥іµґЈЄєЇїЉљЊњ" +
          "јЅ¬√ƒ≈∆«»… ЋћЌќѕ–—“”‘’÷„ЎўЏџ№Ёёяабвгдежзийклмнопрстуфхцчшщъыьэю",
        // http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/GAELIC.TXT
        "x-mac-gaelic":
          "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØḂ±≤≥ḃĊċḊḋḞḟĠġṀæø" +
          "ṁṖṗɼƒſṠ«»… ÀÃÕŒœ–—“”‘’ṡẛÿŸṪ€‹›Ŷŷṫ·Ỳỳ⁊ÂÊÁËÈÍÎÏÌÓÔ♣ÒÚÛÙıÝýŴŵẄẅẀẁẂẃ",
        // Python: 'mac_greek'
        "x-mac-greek":
          "Ä¹²É³ÖÜ΅àâä΄¨çéèêë£™îï•½‰ôö¦€ùûü†ΓΔΘΛΞΠß®©ΣΪ§≠°·Α±≤≥¥ΒΕΖΗΙΚΜΦΫΨΩ" +
          "άΝ¬ΟΡ≈Τ«»… ΥΧΆΈœ–―“”‘’÷ΉΊΌΎέήίόΏύαβψδεφγηιξκλμνοπώρστθωςχυζϊϋΐΰ\\u00AD",
        // Python: 'mac_iceland'
        "x-mac-icelandic":
          "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûüÝ°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø" +
          "¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€ÐðÞþý·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ",
        // http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/INUIT.TXT
        "x-mac-inuit":
          "ᐃᐄᐅᐆᐊᐋᐱᐲᐳᐴᐸᐹᑉᑎᑏᑐᑑᑕᑖᑦᑭᑮᑯᑰᑲᑳᒃᒋᒌᒍᒎᒐᒑ°ᒡᒥᒦ•¶ᒧ®©™ᒨᒪᒫᒻᓂᓃᓄᓅᓇᓈᓐᓯᓰᓱᓲᓴᓵᔅᓕᓖᓗ" +
          "ᓘᓚᓛᓪᔨᔩᔪᔫᔭ… ᔮᔾᕕᕖᕗ–—“”‘’ᕘᕙᕚᕝᕆᕇᕈᕉᕋᕌᕐᕿᖀᖁᖂᖃᖄᖅᖏᖐᖑᖒᖓᖔᖕᙱᙲᙳᙴᙵᙶᖖᖠᖡᖢᖣᖤᖥᖦᕼŁł",
        // Python: 'mac_latin2'
        "x-mac-ce":
          "ÄĀāÉĄÖÜáąČäčĆćéŹźĎíďĒēĖóėôöõúĚěü†°Ę£§•¶ß®©™ę¨≠ģĮįĪ≤≥īĶ∂∑łĻļĽľĹĺŅ" +
          "ņŃ¬√ńŇ∆«»… ňŐÕőŌ–—“”‘’÷◊ōŔŕŘ‹›řŖŗŠ‚„šŚśÁŤťÍŽžŪÓÔūŮÚůŰűŲųÝýķŻŁżĢˇ",
        // Python: 'mac_roman'
        macintosh:
          "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø" +
          "¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ",
        // Python: 'mac_romanian'
        "x-mac-romanian":
          "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ĂȘ∞±≤≥¥µ∂∑∏π∫ªºΩăș" +
          "¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›Țț‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ",
        // Python: 'mac_turkish'
        "x-mac-turkish":
          "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø" +
          "¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸĞğİıŞş‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙˆ˜¯˘˙˚¸˝˛ˇ",
      };

      /**
       * Decodes an old-style Macintosh string. Returns either a Unicode JavaScript
       * string, or 'undefined' if the encoding is unsupported. For example, we do
       * not support Chinese, Japanese or Korean because these would need large
       * mapping tables.
       * @param {DataView} dataView
       * @param {number} offset
       * @param {number} dataLength
       * @param {string} encoding
       * @returns {string}
       */
      decode.MACSTRING = function (dataView, offset, dataLength, encoding) {
        var table = eightBitMacEncodings[encoding];
        if (table === undefined) {
          return undefined;
        }

        var result = "";
        for (var i = 0; i < dataLength; i++) {
          var c = dataView.getUint8(offset + i);
          // In all eight-bit Mac encodings, the characters 0x00..0x7F are
          // mapped to U+0000..U+007F; we only need to look up the others.
          if (c <= 0x7f) {
            result += String.fromCharCode(c);
          } else {
            result += table[c & 0x7f];
          }
        }

        return result;
      };

      // Helper function for encode.MACSTRING. Returns a dictionary for mapping
      // Unicode character codes to their 8-bit MacOS equivalent. This table
      // is not exactly a super cheap data structure, but we do not care because
      // encoding Macintosh strings is only rarely needed in typical applications.
      var macEncodingTableCache =
        typeof WeakMap === "function" && new WeakMap();
      var macEncodingCacheKeys;
      var getMacEncodingTable = function (encoding) {
        // Since we use encoding as a cache key for WeakMap, it has to be
        // a String object and not a literal. And at least on NodeJS 2.10.1,
        // WeakMap requires that the same String instance is passed for cache hits.
        if (!macEncodingCacheKeys) {
          macEncodingCacheKeys = {};
          for (var e in eightBitMacEncodings) {
            /*jshint -W053 */ // Suppress "Do not use String as a constructor."
            macEncodingCacheKeys[e] = new String(e);
          }
        }

        var cacheKey = macEncodingCacheKeys[encoding];
        if (cacheKey === undefined) {
          return undefined;
        }

        // We can't do "if (cache.has(key)) {return cache.get(key)}" here:
        // since garbage collection may run at any time, it could also kick in
        // between the calls to cache.has() and cache.get(). In that case,
        // we would return 'undefined' even though we do support the encoding.
        if (macEncodingTableCache) {
          var cachedTable = macEncodingTableCache.get(cacheKey);
          if (cachedTable !== undefined) {
            return cachedTable;
          }
        }

        var decodingTable = eightBitMacEncodings[encoding];
        if (decodingTable === undefined) {
          return undefined;
        }

        var encodingTable = {};
        for (var i = 0; i < decodingTable.length; i++) {
          encodingTable[decodingTable.charCodeAt(i)] = i + 0x80;
        }

        if (macEncodingTableCache) {
          macEncodingTableCache.set(cacheKey, encodingTable);
        }

        return encodingTable;
      };

      /**
       * Encodes an old-style Macintosh string. Returns a byte array upon success.
       * If the requested encoding is unsupported, or if the input string contains
       * a character that cannot be expressed in the encoding, the function returns
       * 'undefined'.
       * @param {string} str
       * @param {string} encoding
       * @returns {Array}
       */
      encode.MACSTRING = function (str, encoding) {
        var table = getMacEncodingTable(encoding);
        if (table === undefined) {
          return undefined;
        }

        var result = [];
        for (var i = 0; i < str.length; i++) {
          var c = str.charCodeAt(i);

          // In all eight-bit Mac encodings, the characters 0x00..0x7F are
          // mapped to U+0000..U+007F; we only need to look up the others.
          if (c >= 0x80) {
            c = table[c];
            if (c === undefined) {
              // str contains a Unicode character that cannot be encoded
              // in the requested encoding.
              return undefined;
            }
          }
          result[i] = c;
          // result.push(c);
        }

        return result;
      };

      /**
       * @param {string} str
       * @param {string} encoding
       * @returns {number}
       */
      sizeOf.MACSTRING = function (str, encoding) {
        var b = encode.MACSTRING(str, encoding);
        if (b !== undefined) {
          return b.length;
        } else {
          return 0;
        }
      };

      // Helper for encode.VARDELTAS
      function isByteEncodable(value) {
        return value >= -128 && value <= 127;
      }

      // Helper for encode.VARDELTAS
      function encodeVarDeltaRunAsZeroes(deltas, pos, result) {
        var runLength = 0;
        var numDeltas = deltas.length;
        while (pos < numDeltas && runLength < 64 && deltas[pos] === 0) {
          ++pos;
          ++runLength;
        }
        result.push(0x80 | (runLength - 1));
        return pos;
      }

      // Helper for encode.VARDELTAS
      function encodeVarDeltaRunAsBytes(deltas, offset, result) {
        var runLength = 0;
        var numDeltas = deltas.length;
        var pos = offset;
        while (pos < numDeltas && runLength < 64) {
          var value = deltas[pos];
          if (!isByteEncodable(value)) {
            break;
          }

          // Within a byte-encoded run of deltas, a single zero is best
          // stored literally as 0x00 value. However, if we have two or
          // more zeroes in a sequence, it is better to start a new run.
          // Fore example, the sequence of deltas [15, 15, 0, 15, 15]
          // becomes 6 bytes (04 0F 0F 00 0F 0F) when storing the zero
          // within the current run, but 7 bytes (01 0F 0F 80 01 0F 0F)
          // when starting a new run.
          if (value === 0 && pos + 1 < numDeltas && deltas[pos + 1] === 0) {
            break;
          }

          ++pos;
          ++runLength;
        }
        result.push(runLength - 1);
        for (var i = offset; i < pos; ++i) {
          result.push((deltas[i] + 256) & 0xff);
        }
        return pos;
      }

      // Helper for encode.VARDELTAS
      function encodeVarDeltaRunAsWords(deltas, offset, result) {
        var runLength = 0;
        var numDeltas = deltas.length;
        var pos = offset;
        while (pos < numDeltas && runLength < 64) {
          var value = deltas[pos];

          // Within a word-encoded run of deltas, it is easiest to start
          // a new run (with a different encoding) whenever we encounter
          // a zero value. For example, the sequence [0x6666, 0, 0x7777]
          // needs 7 bytes when storing the zero inside the current run
          // (42 66 66 00 00 77 77), and equally 7 bytes when starting a
          // new run (40 66 66 80 40 77 77).
          if (value === 0) {
            break;
          }

          // Within a word-encoded run of deltas, a single value in the
          // range (-128..127) should be encoded within the current run
          // because it is more compact. For example, the sequence
          // [0x6666, 2, 0x7777] becomes 7 bytes when storing the value
          // literally (42 66 66 00 02 77 77), but 8 bytes when starting
          // a new run (40 66 66 00 02 40 77 77).
          if (
            isByteEncodable(value) &&
            pos + 1 < numDeltas &&
            isByteEncodable(deltas[pos + 1])
          ) {
            break;
          }

          ++pos;
          ++runLength;
        }
        result.push(0x40 | (runLength - 1));
        for (var i = offset; i < pos; ++i) {
          var val = deltas[i];
          result.push(((val + 0x10000) >> 8) & 0xff, (val + 0x100) & 0xff);
        }
        return pos;
      }

      /**
       * Encode a list of variation adjustment deltas.
       *
       * Variation adjustment deltas are used in ‘gvar’ and ‘cvar’ tables.
       * They indicate how points (in ‘gvar’) or values (in ‘cvar’) get adjusted
       * when generating instances of variation fonts.
       *
       * @see https://www.microsoft.com/typography/otspec/gvar.htm
       * @see https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6gvar.html
       * @param {Array}
       * @return {Array}
       */
      encode.VARDELTAS = function (deltas) {
        var pos = 0;
        var result = [];
        while (pos < deltas.length) {
          var value = deltas[pos];
          if (value === 0) {
            pos = encodeVarDeltaRunAsZeroes(deltas, pos, result);
          } else if (value >= -128 && value <= 127) {
            pos = encodeVarDeltaRunAsBytes(deltas, pos, result);
          } else {
            pos = encodeVarDeltaRunAsWords(deltas, pos, result);
          }
        }
        return result;
      };

      // Convert a list of values to a CFF INDEX structure.
      // The values should be objects containing name / type / value.
      /**
       * @param {Array} l
       * @returns {Array}
       */
      encode.INDEX = function (l) {
        //var offset, offsets, offsetEncoder, encodedOffsets, encodedOffset, data,
        //	i, v;
        // Because we have to know which data type to use to encode the offsets,
        // we have to go through the values twice: once to encode the data and
        // calculate the offsets, then again to encode the offsets using the fitting data type.
        var offset = 1; // First offset is always 1.
        var offsets = [offset];
        var data = [];
        for (var i = 0; i < l.length; i += 1) {
          var v = encode.OBJECT(l[i]);
          Array.prototype.push.apply(data, v);
          offset += v.length;
          offsets.push(offset);
        }

        if (data.length === 0) {
          return [0, 0];
        }

        var encodedOffsets = [];
        var offSize = (1 + Math.floor(Math.log(offset) / Math.log(2)) / 8) | 0;
        var offsetEncoder = [
          undefined,
          encode.BYTE,
          encode.USHORT,
          encode.UINT24,
          encode.ULONG,
        ][offSize];
        for (var i$1 = 0; i$1 < offsets.length; i$1 += 1) {
          var encodedOffset = offsetEncoder(offsets[i$1]);
          Array.prototype.push.apply(encodedOffsets, encodedOffset);
        }

        return Array.prototype.concat(
          encode.Card16(l.length),
          encode.OffSize(offSize),
          encodedOffsets,
          data
        );
      };

      /**
       * @param {Array}
       * @returns {number}
       */
      sizeOf.INDEX = function (v) {
        return encode.INDEX(v).length;
      };

      /**
       * Convert an object to a CFF DICT structure.
       * The keys should be numeric.
       * The values should be objects containing name / type / value.
       * @param {Object} m
       * @returns {Array}
       */
      encode.DICT = function (m) {
        var d = [];
        var keys = Object.keys(m);
        var length = keys.length;

        for (var i = 0; i < length; i += 1) {
          // Object.keys() return string keys, but our keys are always numeric.
          var k = parseInt(keys[i], 0);
          var v = m[k];
          // Value comes before the key.
          d = d.concat(encode.OPERAND(v.value, v.type));
          d = d.concat(encode.OPERATOR(k));
        }

        return d;
      };

      /**
       * @param {Object}
       * @returns {number}
       */
      sizeOf.DICT = function (m) {
        return encode.DICT(m).length;
      };

      /**
       * @param {number}
       * @returns {Array}
       */
      encode.OPERATOR = function (v) {
        if (v < 1200) {
          return [v];
        } else {
          return [12, v - 1200];
        }
      };

      /**
       * @param {Array} v
       * @param {string}
       * @returns {Array}
       */
      encode.OPERAND = function (v, type) {
        var d = [];
        if (Array.isArray(type)) {
          for (var i = 0; i < type.length; i += 1) {
            check.argument(
              v.length === type.length,
              "Not enough arguments given for type" + type
            );
            d = d.concat(encode.OPERAND(v[i], type[i]));
          }
        } else {
          if (type === "SID") {
            d = d.concat(encode.NUMBER(v));
          } else if (type === "offset") {
            // We make it easy for ourselves and always encode offsets as
            // 4 bytes. This makes offset calculation for the top dict easier.
            d = d.concat(encode.NUMBER32(v));
          } else if (type === "number") {
            d = d.concat(encode.NUMBER(v));
          } else if (type === "real") {
            d = d.concat(encode.REAL(v));
          } else {
            throw new Error("Unknown operand type " + type);
            // FIXME Add support for booleans
          }
        }

        return d;
      };

      encode.OP = encode.BYTE;
      sizeOf.OP = sizeOf.BYTE;

      // memoize charstring encoding using WeakMap if available
      var wmm = typeof WeakMap === "function" && new WeakMap();

      /**
       * Convert a list of CharString operations to bytes.
       * @param {Array}
       * @returns {Array}
       */
      encode.CHARSTRING = function (ops) {
        // See encode.MACSTRING for why we don't do "if (wmm && wmm.has(ops))".
        if (wmm) {
          var cachedValue = wmm.get(ops);
          if (cachedValue !== undefined) {
            return cachedValue;
          }
        }

        var d = [];
        var length = ops.length;

        for (var i = 0; i < length; i += 1) {
          var op = ops[i];
          d = d.concat(encode[op.type](op.value));
        }

        if (wmm) {
          wmm.set(ops, d);
        }

        return d;
      };

      /**
       * @param {Array}
       * @returns {number}
       */
      sizeOf.CHARSTRING = function (ops) {
        return encode.CHARSTRING(ops).length;
      };

      // Utility functions ////////////////////////////////////////////////////////

      /**
       * Convert an object containing name / type / value to bytes.
       * @param {Object}
       * @returns {Array}
       */
      encode.OBJECT = function (v) {
        var encodingFunction = encode[v.type];
        check.argument(
          encodingFunction !== undefined,
          "No encoding function for type " + v.type
        );
        return encodingFunction(v.value);
      };

      /**
       * @param {Object}
       * @returns {number}
       */
      sizeOf.OBJECT = function (v) {
        var sizeOfFunction = sizeOf[v.type];
        check.argument(
          sizeOfFunction !== undefined,
          "No sizeOf function for type " + v.type
        );
        return sizeOfFunction(v.value);
      };

      /**
       * Convert a table object to bytes.
       * A table contains a list of fields containing the metadata (name, type and default value).
       * The table itself has the field values set as attributes.
       * @param {opentype.Table}
       * @returns {Array}
       */
      encode.TABLE = function (table) {
        var d = [];
        var length = table.fields.length;
        var subtables = [];
        var subtableOffsets = [];

        for (var i = 0; i < length; i += 1) {
          var field = table.fields[i];
          var encodingFunction = encode[field.type];
          check.argument(
            encodingFunction !== undefined,
            "No encoding function for field type " +
              field.type +
              " (" +
              field.name +
              ")"
          );
          var value = table[field.name];
          if (value === undefined) {
            value = field.value;
          }

          var bytes = encodingFunction(value);

          if (field.type === "TABLE") {
            subtableOffsets.push(d.length);
            d = d.concat([0, 0]);
            subtables.push(bytes);
          } else {
            d = d.concat(bytes);
          }
        }

        for (var i$1 = 0; i$1 < subtables.length; i$1 += 1) {
          var o = subtableOffsets[i$1];
          var offset = d.length;
          check.argument(
            offset < 65536,
            "Table " + table.tableName + " too big."
          );
          d[o] = offset >> 8;
          d[o + 1] = offset & 0xff;
          d = d.concat(subtables[i$1]);
        }

        return d;
      };

      /**
       * @param {opentype.Table}
       * @returns {number}
       */
      sizeOf.TABLE = function (table) {
        var numBytes = 0;
        var length = table.fields.length;

        for (var i = 0; i < length; i += 1) {
          var field = table.fields[i];
          var sizeOfFunction = sizeOf[field.type];
          check.argument(
            sizeOfFunction !== undefined,
            "No sizeOf function for field type " +
              field.type +
              " (" +
              field.name +
              ")"
          );
          var value = table[field.name];
          if (value === undefined) {
            value = field.value;
          }

          numBytes += sizeOfFunction(value);

          // Subtables take 2 more bytes for offsets.
          if (field.type === "TABLE") {
            numBytes += 2;
          }
        }

        return numBytes;
      };

      encode.RECORD = encode.TABLE;
      sizeOf.RECORD = sizeOf.TABLE;

      // Merge in a list of bytes.
      encode.LITERAL = function (v) {
        return v;
      };

      sizeOf.LITERAL = function (v) {
        return v.length;
      };

      // Table metadata

      /**
       * @exports opentype.Table
       * @class
       * @param {string} tableName
       * @param {Array} fields
       * @param {Object} options
       * @constructor
       */
      function Table(tableName, fields, options) {
        var this$1 = this;

        for (var i = 0; i < fields.length; i += 1) {
          var field = fields[i];
          this$1[field.name] = field.value;
        }

        this.tableName = tableName;
        this.fields = fields;
        if (options) {
          var optionKeys = Object.keys(options);
          for (var i$1 = 0; i$1 < optionKeys.length; i$1 += 1) {
            var k = optionKeys[i$1];
            var v = options[k];
            if (this$1[k] !== undefined) {
              this$1[k] = v;
            }
          }
        }
      }

      /**
       * Encodes the table and returns an array of bytes
       * @return {Array}
       */
      Table.prototype.encode = function () {
        return encode.TABLE(this);
      };

      /**
       * Get the size of the table.
       * @return {number}
       */
      Table.prototype.sizeOf = function () {
        return sizeOf.TABLE(this);
      };

      /**
       * @private
       */
      function ushortList(itemName, list, count) {
        if (count === undefined) {
          count = list.length;
        }
        var fields = new Array(list.length + 1);
        fields[0] = { name: itemName + "Count", type: "USHORT", value: count };
        for (var i = 0; i < list.length; i++) {
          fields[i + 1] = {
            name: itemName + i,
            type: "USHORT",
            value: list[i],
          };
        }
        return fields;
      }

      /**
       * @private
       */
      function tableList(itemName, records, itemCallback) {
        var count = records.length;
        var fields = new Array(count + 1);
        fields[0] = { name: itemName + "Count", type: "USHORT", value: count };
        for (var i = 0; i < count; i++) {
          fields[i + 1] = {
            name: itemName + i,
            type: "TABLE",
            value: itemCallback(records[i], i),
          };
        }
        return fields;
      }

      /**
       * @private
       */
      function recordList(itemName, records, itemCallback) {
        var count = records.length;
        var fields = [];
        fields[0] = { name: itemName + "Count", type: "USHORT", value: count };
        for (var i = 0; i < count; i++) {
          fields = fields.concat(itemCallback(records[i], i));
        }
        return fields;
      }

      // Common Layout Tables

      /**
       * @exports opentype.Coverage
       * @class
       * @param {opentype.Table}
       * @constructor
       * @extends opentype.Table
       */
      function Coverage(coverageTable) {
        if (coverageTable.format === 1) {
          Table.call(
            this,
            "coverageTable",
            [{ name: "coverageFormat", type: "USHORT", value: 1 }].concat(
              ushortList("glyph", coverageTable.glyphs)
            )
          );
        } else {
          check.assert(false, "Can't create coverage table format 2 yet.");
        }
      }
      Coverage.prototype = Object.create(Table.prototype);
      Coverage.prototype.constructor = Coverage;

      function ScriptList(scriptListTable) {
        Table.call(
          this,
          "scriptListTable",
          recordList(
            "scriptRecord",
            scriptListTable,
            function (scriptRecord, i) {
              var script = scriptRecord.script;
              var defaultLangSys = script.defaultLangSys;
              check.assert(
                !!defaultLangSys,
                "Unable to write GSUB: script " +
                  scriptRecord.tag +
                  " has no default language system."
              );
              return [
                { name: "scriptTag" + i, type: "TAG", value: scriptRecord.tag },
                {
                  name: "script" + i,
                  type: "TABLE",
                  value: new Table(
                    "scriptTable",
                    [
                      {
                        name: "defaultLangSys",
                        type: "TABLE",
                        value: new Table(
                          "defaultLangSys",
                          [
                            { name: "lookupOrder", type: "USHORT", value: 0 },
                            {
                              name: "reqFeatureIndex",
                              type: "USHORT",
                              value: defaultLangSys.reqFeatureIndex,
                            },
                          ].concat(
                            ushortList(
                              "featureIndex",
                              defaultLangSys.featureIndexes
                            )
                          )
                        ),
                      },
                    ].concat(
                      recordList(
                        "langSys",
                        script.langSysRecords,
                        function (langSysRecord, i) {
                          var langSys = langSysRecord.langSys;
                          return [
                            {
                              name: "langSysTag" + i,
                              type: "TAG",
                              value: langSysRecord.tag,
                            },
                            {
                              name: "langSys" + i,
                              type: "TABLE",
                              value: new Table(
                                "langSys",
                                [
                                  {
                                    name: "lookupOrder",
                                    type: "USHORT",
                                    value: 0,
                                  },
                                  {
                                    name: "reqFeatureIndex",
                                    type: "USHORT",
                                    value: langSys.reqFeatureIndex,
                                  },
                                ].concat(
                                  ushortList(
                                    "featureIndex",
                                    langSys.featureIndexes
                                  )
                                )
                              ),
                            },
                          ];
                        }
                      )
                    )
                  ),
                },
              ];
            }
          )
        );
      }
      ScriptList.prototype = Object.create(Table.prototype);
      ScriptList.prototype.constructor = ScriptList;

      /**
       * @exports opentype.FeatureList
       * @class
       * @param {opentype.Table}
       * @constructor
       * @extends opentype.Table
       */
      function FeatureList(featureListTable) {
        Table.call(
          this,
          "featureListTable",
          recordList(
            "featureRecord",
            featureListTable,
            function (featureRecord, i) {
              var feature = featureRecord.feature;
              return [
                {
                  name: "featureTag" + i,
                  type: "TAG",
                  value: featureRecord.tag,
                },
                {
                  name: "feature" + i,
                  type: "TABLE",
                  value: new Table(
                    "featureTable",
                    [
                      {
                        name: "featureParams",
                        type: "USHORT",
                        value: feature.featureParams,
                      },
                    ].concat(
                      ushortList("lookupListIndex", feature.lookupListIndexes)
                    )
                  ),
                },
              ];
            }
          )
        );
      }
      FeatureList.prototype = Object.create(Table.prototype);
      FeatureList.prototype.constructor = FeatureList;

      /**
       * @exports opentype.LookupList
       * @class
       * @param {opentype.Table}
       * @param {Object}
       * @constructor
       * @extends opentype.Table
       */
      function LookupList(lookupListTable, subtableMakers) {
        Table.call(
          this,
          "lookupListTable",
          tableList("lookup", lookupListTable, function (lookupTable) {
            var subtableCallback = subtableMakers[lookupTable.lookupType];
            check.assert(
              !!subtableCallback,
              "Unable to write GSUB lookup type " +
                lookupTable.lookupType +
                " tables."
            );
            return new Table(
              "lookupTable",
              [
                {
                  name: "lookupType",
                  type: "USHORT",
                  value: lookupTable.lookupType,
                },
                {
                  name: "lookupFlag",
                  type: "USHORT",
                  value: lookupTable.lookupFlag,
                },
              ].concat(
                tableList("subtable", lookupTable.subtables, subtableCallback)
              )
            );
          })
        );
      }
      LookupList.prototype = Object.create(Table.prototype);
      LookupList.prototype.constructor = LookupList;

      // Record = same as Table, but inlined (a Table has an offset and its data is further in the stream)
      // Don't use offsets inside Records (probable bug), only in Tables.
      var table = {
        Table: Table,
        Record: Table,
        Coverage: Coverage,
        ScriptList: ScriptList,
        FeatureList: FeatureList,
        LookupList: LookupList,
        ushortList: ushortList,
        tableList: tableList,
        recordList: recordList,
      };

      // Parsing utility functions

      // Retrieve an unsigned byte from the DataView.
      function getByte(dataView, offset) {
        return dataView.getUint8(offset);
      }

      // Retrieve an unsigned 16-bit short from the DataView.
      // The value is stored in big endian.
      function getUShort(dataView, offset) {
        return dataView.getUint16(offset, false);
      }

      // Retrieve a signed 16-bit short from the DataView.
      // The value is stored in big endian.
      function getShort(dataView, offset) {
        return dataView.getInt16(offset, false);
      }

      // Retrieve an unsigned 32-bit long from the DataView.
      // The value is stored in big endian.
      function getULong(dataView, offset) {
        return dataView.getUint32(offset, false);
      }

      // Retrieve a 32-bit signed fixed-point number (16.16) from the DataView.
      // The value is stored in big endian.
      function getFixed(dataView, offset) {
        var decimal = dataView.getInt16(offset, false);
        var fraction = dataView.getUint16(offset + 2, false);
        return decimal + fraction / 65535;
      }

      // Retrieve a 4-character tag from the DataView.
      // Tags are used to identify tables.
      function getTag(dataView, offset) {
        var tag = "";
        for (var i = offset; i < offset + 4; i += 1) {
          tag += String.fromCharCode(dataView.getInt8(i));
        }

        return tag;
      }

      // Retrieve an offset from the DataView.
      // Offsets are 1 to 4 bytes in length, depending on the offSize argument.
      function getOffset(dataView, offset, offSize) {
        var v = 0;
        for (var i = 0; i < offSize; i += 1) {
          v <<= 8;
          v += dataView.getUint8(offset + i);
        }

        return v;
      }

      // Retrieve a number of bytes from start offset to the end offset from the DataView.
      function getBytes(dataView, startOffset, endOffset) {
        var bytes = [];
        for (var i = startOffset; i < endOffset; i += 1) {
          bytes.push(dataView.getUint8(i));
        }

        return bytes;
      }

      // Convert the list of bytes to a string.
      function bytesToString(bytes) {
        var s = "";
        for (var i = 0; i < bytes.length; i += 1) {
          s += String.fromCharCode(bytes[i]);
        }

        return s;
      }

      var typeOffsets = {
        byte: 1,
        uShort: 2,
        short: 2,
        uLong: 4,
        fixed: 4,
        longDateTime: 8,
        tag: 4,
      };

      // A stateful parser that changes the offset whenever a value is retrieved.
      // The data is a DataView.
      function Parser(data, offset) {
        this.data = data;
        this.offset = offset;
        this.relativeOffset = 0;
      }

      Parser.prototype.parseByte = function () {
        var v = this.data.getUint8(this.offset + this.relativeOffset);
        this.relativeOffset += 1;
        return v;
      };

      Parser.prototype.parseChar = function () {
        var v = this.data.getInt8(this.offset + this.relativeOffset);
        this.relativeOffset += 1;
        return v;
      };

      Parser.prototype.parseCard8 = Parser.prototype.parseByte;

      Parser.prototype.parseUShort = function () {
        var v = this.data.getUint16(this.offset + this.relativeOffset);
        this.relativeOffset += 2;
        return v;
      };

      Parser.prototype.parseCard16 = Parser.prototype.parseUShort;
      Parser.prototype.parseSID = Parser.prototype.parseUShort;
      Parser.prototype.parseOffset16 = Parser.prototype.parseUShort;

      Parser.prototype.parseShort = function () {
        var v = this.data.getInt16(this.offset + this.relativeOffset);
        this.relativeOffset += 2;
        return v;
      };

      Parser.prototype.parseF2Dot14 = function () {
        var v = this.data.getInt16(this.offset + this.relativeOffset) / 16384;
        this.relativeOffset += 2;
        return v;
      };

      Parser.prototype.parseULong = function () {
        var v = getULong(this.data, this.offset + this.relativeOffset);
        this.relativeOffset += 4;
        return v;
      };

      Parser.prototype.parseOffset32 = Parser.prototype.parseULong;

      Parser.prototype.parseFixed = function () {
        var v = getFixed(this.data, this.offset + this.relativeOffset);
        this.relativeOffset += 4;
        return v;
      };

      Parser.prototype.parseString = function (length) {
        var dataView = this.data;
        var offset = this.offset + this.relativeOffset;
        var string = "";
        this.relativeOffset += length;
        for (var i = 0; i < length; i++) {
          string += String.fromCharCode(dataView.getUint8(offset + i));
        }

        return string;
      };

      Parser.prototype.parseTag = function () {
        return this.parseString(4);
      };

      // LONGDATETIME is a 64-bit integer.
      // JavaScript and unix timestamps traditionally use 32 bits, so we
      // only take the last 32 bits.
      // + Since until 2038 those bits will be filled by zeros we can ignore them.
      Parser.prototype.parseLongDateTime = function () {
        var v = getULong(this.data, this.offset + this.relativeOffset + 4);
        // Subtract seconds between 01/01/1904 and 01/01/1970
        // to convert Apple Mac timestamp to Standard Unix timestamp
        v -= 2082844800;
        this.relativeOffset += 8;
        return v;
      };

      Parser.prototype.parseVersion = function (minorBase) {
        var major = getUShort(this.data, this.offset + this.relativeOffset);

        // How to interpret the minor version is very vague in the spec. 0x5000 is 5, 0x1000 is 1
        // Default returns the correct number if minor = 0xN000 where N is 0-9
        // Set minorBase to 1 for tables that use minor = N where N is 0-9
        var minor = getUShort(this.data, this.offset + this.relativeOffset + 2);
        this.relativeOffset += 4;
        if (minorBase === undefined) {
          minorBase = 0x1000;
        }
        return major + minor / minorBase / 10;
      };

      Parser.prototype.skip = function (type, amount) {
        if (amount === undefined) {
          amount = 1;
        }

        this.relativeOffset += typeOffsets[type] * amount;
      };

      ///// Parsing lists and records ///////////////////////////////

      // Parse a list of 32 bit unsigned integers.
      Parser.prototype.parseULongList = function (count) {
        if (count === undefined) {
          count = this.parseULong();
        }
        var offsets = new Array(count);
        var dataView = this.data;
        var offset = this.offset + this.relativeOffset;
        for (var i = 0; i < count; i++) {
          offsets[i] = dataView.getUint32(offset);
          offset += 4;
        }

        this.relativeOffset += count * 4;
        return offsets;
      };

      // Parse a list of 16 bit unsigned integers. The length of the list can be read on the stream
      // or provided as an argument.
      Parser.prototype.parseOffset16List = Parser.prototype.parseUShortList =
        function (count) {
          if (count === undefined) {
            count = this.parseUShort();
          }
          var offsets = new Array(count);
          var dataView = this.data;
          var offset = this.offset + this.relativeOffset;
          for (var i = 0; i < count; i++) {
            offsets[i] = dataView.getUint16(offset);
            offset += 2;
          }

          this.relativeOffset += count * 2;
          return offsets;
        };

      // Parses a list of 16 bit signed integers.
      Parser.prototype.parseShortList = function (count) {
        var list = new Array(count);
        var dataView = this.data;
        var offset = this.offset + this.relativeOffset;
        for (var i = 0; i < count; i++) {
          list[i] = dataView.getInt16(offset);
          offset += 2;
        }

        this.relativeOffset += count * 2;
        return list;
      };

      // Parses a list of bytes.
      Parser.prototype.parseByteList = function (count) {
        var list = new Array(count);
        var dataView = this.data;
        var offset = this.offset + this.relativeOffset;
        for (var i = 0; i < count; i++) {
          list[i] = dataView.getUint8(offset++);
        }

        this.relativeOffset += count;
        return list;
      };

      /**
       * Parse a list of items.
       * Record count is optional, if omitted it is read from the stream.
       * itemCallback is one of the Parser methods.
       */
      Parser.prototype.parseList = function (count, itemCallback) {
        var this$1 = this;

        if (!itemCallback) {
          itemCallback = count;
          count = this.parseUShort();
        }
        var list = new Array(count);
        for (var i = 0; i < count; i++) {
          list[i] = itemCallback.call(this$1);
        }
        return list;
      };

      Parser.prototype.parseList32 = function (count, itemCallback) {
        var this$1 = this;

        if (!itemCallback) {
          itemCallback = count;
          count = this.parseULong();
        }
        var list = new Array(count);
        for (var i = 0; i < count; i++) {
          list[i] = itemCallback.call(this$1);
        }
        return list;
      };

      /**
       * Parse a list of records.
       * Record count is optional, if omitted it is read from the stream.
       * Example of recordDescription: { sequenceIndex: Parser.uShort, lookupListIndex: Parser.uShort }
       */
      Parser.prototype.parseRecordList = function (count, recordDescription) {
        var this$1 = this;

        // If the count argument is absent, read it in the stream.
        if (!recordDescription) {
          recordDescription = count;
          count = this.parseUShort();
        }
        var records = new Array(count);
        var fields = Object.keys(recordDescription);
        for (var i = 0; i < count; i++) {
          var rec = {};
          for (var j = 0; j < fields.length; j++) {
            var fieldName = fields[j];
            var fieldType = recordDescription[fieldName];
            rec[fieldName] = fieldType.call(this$1);
          }
          records[i] = rec;
        }
        return records;
      };

      Parser.prototype.parseRecordList32 = function (count, recordDescription) {
        var this$1 = this;

        // If the count argument is absent, read it in the stream.
        if (!recordDescription) {
          recordDescription = count;
          count = this.parseULong();
        }
        var records = new Array(count);
        var fields = Object.keys(recordDescription);
        for (var i = 0; i < count; i++) {
          var rec = {};
          for (var j = 0; j < fields.length; j++) {
            var fieldName = fields[j];
            var fieldType = recordDescription[fieldName];
            rec[fieldName] = fieldType.call(this$1);
          }
          records[i] = rec;
        }
        return records;
      };

      // Parse a data structure into an object
      // Example of description: { sequenceIndex: Parser.uShort, lookupListIndex: Parser.uShort }
      Parser.prototype.parseStruct = function (description) {
        var this$1 = this;

        if (typeof description === "function") {
          return description.call(this);
        } else {
          var fields = Object.keys(description);
          var struct = {};
          for (var j = 0; j < fields.length; j++) {
            var fieldName = fields[j];
            var fieldType = description[fieldName];
            struct[fieldName] = fieldType.call(this$1);
          }
          return struct;
        }
      };

      /**
       * Parse a GPOS valueRecord
       * https://docs.microsoft.com/en-us/typography/opentype/spec/gpos#value-record
       * valueFormat is optional, if omitted it is read from the stream.
       */
      Parser.prototype.parseValueRecord = function (valueFormat) {
        if (valueFormat === undefined) {
          valueFormat = this.parseUShort();
        }
        if (valueFormat === 0) {
          // valueFormat2 in kerning pairs is most often 0
          // in this case return undefined instead of an empty object, to save space
          return;
        }
        var valueRecord = {};

        if (valueFormat & 0x0001) {
          valueRecord.xPlacement = this.parseShort();
        }
        if (valueFormat & 0x0002) {
          valueRecord.yPlacement = this.parseShort();
        }
        if (valueFormat & 0x0004) {
          valueRecord.xAdvance = this.parseShort();
        }
        if (valueFormat & 0x0008) {
          valueRecord.yAdvance = this.parseShort();
        }

        // Device table (non-variable font) / VariationIndex table (variable font) not supported
        // https://docs.microsoft.com/fr-fr/typography/opentype/spec/chapter2#devVarIdxTbls
        if (valueFormat & 0x0010) {
          valueRecord.xPlaDevice = undefined;
          this.parseShort();
        }
        if (valueFormat & 0x0020) {
          valueRecord.yPlaDevice = undefined;
          this.parseShort();
        }
        if (valueFormat & 0x0040) {
          valueRecord.xAdvDevice = undefined;
          this.parseShort();
        }
        if (valueFormat & 0x0080) {
          valueRecord.yAdvDevice = undefined;
          this.parseShort();
        }

        return valueRecord;
      };

      /**
       * Parse a list of GPOS valueRecords
       * https://docs.microsoft.com/en-us/typography/opentype/spec/gpos#value-record
       * valueFormat and valueCount are read from the stream.
       */
      Parser.prototype.parseValueRecordList = function () {
        var this$1 = this;

        var valueFormat = this.parseUShort();
        var valueCount = this.parseUShort();
        var values = new Array(valueCount);
        for (var i = 0; i < valueCount; i++) {
          values[i] = this$1.parseValueRecord(valueFormat);
        }
        return values;
      };

      Parser.prototype.parsePointer = function (description) {
        var structOffset = this.parseOffset16();
        if (structOffset > 0) {
          // NULL offset => return undefined
          return new Parser(this.data, this.offset + structOffset).parseStruct(
            description
          );
        }
        return undefined;
      };

      Parser.prototype.parsePointer32 = function (description) {
        var structOffset = this.parseOffset32();
        if (structOffset > 0) {
          // NULL offset => return undefined
          return new Parser(this.data, this.offset + structOffset).parseStruct(
            description
          );
        }
        return undefined;
      };

      /**
       * Parse a list of offsets to lists of 16-bit integers,
       * or a list of offsets to lists of offsets to any kind of items.
       * If itemCallback is not provided, a list of list of UShort is assumed.
       * If provided, itemCallback is called on each item and must parse the item.
       * See examples in tables/gsub.js
       */
      Parser.prototype.parseListOfLists = function (itemCallback) {
        var this$1 = this;

        var offsets = this.parseOffset16List();
        var count = offsets.length;
        var relativeOffset = this.relativeOffset;
        var list = new Array(count);
        for (var i = 0; i < count; i++) {
          var start = offsets[i];
          if (start === 0) {
            // NULL offset
            // Add i as owned property to list. Convenient with assert.
            list[i] = undefined;
            continue;
          }
          this$1.relativeOffset = start;
          if (itemCallback) {
            var subOffsets = this$1.parseOffset16List();
            var subList = new Array(subOffsets.length);
            for (var j = 0; j < subOffsets.length; j++) {
              this$1.relativeOffset = start + subOffsets[j];
              subList[j] = itemCallback.call(this$1);
            }
            list[i] = subList;
          } else {
            list[i] = this$1.parseUShortList();
          }
        }
        this.relativeOffset = relativeOffset;
        return list;
      };

      ///// Complex tables parsing //////////////////////////////////

      // Parse a coverage table in a GSUB, GPOS or GDEF table.
      // https://www.microsoft.com/typography/OTSPEC/chapter2.htm
      // parser.offset must point to the start of the table containing the coverage.
      Parser.prototype.parseCoverage = function () {
        var this$1 = this;

        var startOffset = this.offset + this.relativeOffset;
        var format = this.parseUShort();
        var count = this.parseUShort();
        if (format === 1) {
          return {
            format: 1,
            glyphs: this.parseUShortList(count),
          };
        } else if (format === 2) {
          var ranges = new Array(count);
          for (var i = 0; i < count; i++) {
            ranges[i] = {
              start: this$1.parseUShort(),
              end: this$1.parseUShort(),
              index: this$1.parseUShort(),
            };
          }
          return {
            format: 2,
            ranges: ranges,
          };
        }
        throw new Error(
          "0x" + startOffset.toString(16) + ": Coverage format must be 1 or 2."
        );
      };

      // Parse a Class Definition Table in a GSUB, GPOS or GDEF table.
      // https://www.microsoft.com/typography/OTSPEC/chapter2.htm
      Parser.prototype.parseClassDef = function () {
        var startOffset = this.offset + this.relativeOffset;
        var format = this.parseUShort();
        if (format === 1) {
          return {
            format: 1,
            startGlyph: this.parseUShort(),
            classes: this.parseUShortList(),
          };
        } else if (format === 2) {
          return {
            format: 2,
            ranges: this.parseRecordList({
              start: Parser.uShort,
              end: Parser.uShort,
              classId: Parser.uShort,
            }),
          };
        }
        throw new Error(
          "0x" + startOffset.toString(16) + ": ClassDef format must be 1 or 2."
        );
      };

      ///// Static methods ///////////////////////////////////
      // These convenience methods can be used as callbacks and should be called with "this" context set to a Parser instance.

      Parser.list = function (count, itemCallback) {
        return function () {
          return this.parseList(count, itemCallback);
        };
      };

      Parser.list32 = function (count, itemCallback) {
        return function () {
          return this.parseList32(count, itemCallback);
        };
      };

      Parser.recordList = function (count, recordDescription) {
        return function () {
          return this.parseRecordList(count, recordDescription);
        };
      };

      Parser.recordList32 = function (count, recordDescription) {
        return function () {
          return this.parseRecordList32(count, recordDescription);
        };
      };

      Parser.pointer = function (description) {
        return function () {
          return this.parsePointer(description);
        };
      };

      Parser.pointer32 = function (description) {
        return function () {
          return this.parsePointer32(description);
        };
      };

      Parser.tag = Parser.prototype.parseTag;
      Parser.byte = Parser.prototype.parseByte;
      Parser.uShort = Parser.offset16 = Parser.prototype.parseUShort;
      Parser.uShortList = Parser.prototype.parseUShortList;
      Parser.uLong = Parser.offset32 = Parser.prototype.parseULong;
      Parser.uLongList = Parser.prototype.parseULongList;
      Parser.struct = Parser.prototype.parseStruct;
      Parser.coverage = Parser.prototype.parseCoverage;
      Parser.classDef = Parser.prototype.parseClassDef;

      ///// Script, Feature, Lookup lists ///////////////////////////////////////////////
      // https://www.microsoft.com/typography/OTSPEC/chapter2.htm

      var langSysTable = {
        reserved: Parser.uShort,
        reqFeatureIndex: Parser.uShort,
        featureIndexes: Parser.uShortList,
      };

      Parser.prototype.parseScriptList = function () {
        return (
          this.parsePointer(
            Parser.recordList({
              tag: Parser.tag,
              script: Parser.pointer({
                defaultLangSys: Parser.pointer(langSysTable),
                langSysRecords: Parser.recordList({
                  tag: Parser.tag,
                  langSys: Parser.pointer(langSysTable),
                }),
              }),
            })
          ) || []
        );
      };

      Parser.prototype.parseFeatureList = function () {
        return (
          this.parsePointer(
            Parser.recordList({
              tag: Parser.tag,
              feature: Parser.pointer({
                featureParams: Parser.offset16,
                lookupListIndexes: Parser.uShortList,
              }),
            })
          ) || []
        );
      };

      Parser.prototype.parseLookupList = function (lookupTableParsers) {
        return (
          this.parsePointer(
            Parser.list(
              Parser.pointer(function () {
                var lookupType = this.parseUShort();
                check.argument(
                  1 <= lookupType && lookupType <= 9,
                  "GPOS/GSUB lookup type " + lookupType + " unknown."
                );
                var lookupFlag = this.parseUShort();
                var useMarkFilteringSet = lookupFlag & 0x10;
                return {
                  lookupType: lookupType,
                  lookupFlag: lookupFlag,
                  subtables: this.parseList(
                    Parser.pointer(lookupTableParsers[lookupType])
                  ),
                  markFilteringSet: useMarkFilteringSet
                    ? this.parseUShort()
                    : undefined,
                };
              })
            )
          ) || []
        );
      };

      Parser.prototype.parseFeatureVariationsList = function () {
        return (
          this.parsePointer32(function () {
            var majorVersion = this.parseUShort();
            var minorVersion = this.parseUShort();
            check.argument(
              majorVersion === 1 && minorVersion < 1,
              "GPOS/GSUB feature variations table unknown."
            );
            var featureVariations = this.parseRecordList32({
              conditionSetOffset: Parser.offset32,
              featureTableSubstitutionOffset: Parser.offset32,
            });
            return featureVariations;
          }) || []
        );
      };

      var parse = {
        getByte: getByte,
        getCard8: getByte,
        getUShort: getUShort,
        getCard16: getUShort,
        getShort: getShort,
        getULong: getULong,
        getFixed: getFixed,
        getTag: getTag,
        getOffset: getOffset,
        getBytes: getBytes,
        bytesToString: bytesToString,
        Parser: Parser,
      };

      // The \`cmap\` table stores the mappings from characters to glyphs.

      function parseCmapTableFormat12(cmap, p) {
        //Skip reserved.
        p.parseUShort();

        // Length in bytes of the sub-tables.
        cmap.length = p.parseULong();
        cmap.language = p.parseULong();

        var groupCount;
        cmap.groupCount = groupCount = p.parseULong();
        cmap.glyphIndexMap = {};

        for (var i = 0; i < groupCount; i += 1) {
          var startCharCode = p.parseULong();
          var endCharCode = p.parseULong();
          var startGlyphId = p.parseULong();

          for (var c = startCharCode; c <= endCharCode; c += 1) {
            cmap.glyphIndexMap[c] = startGlyphId;
            startGlyphId++;
          }
        }
      }

      function parseCmapTableFormat4(cmap, p, data, start, offset) {
        // Length in bytes of the sub-tables.
        cmap.length = p.parseUShort();
        cmap.language = p.parseUShort();

        // segCount is stored x 2.
        var segCount;
        cmap.segCount = segCount = p.parseUShort() >> 1;

        // Skip searchRange, entrySelector, rangeShift.
        p.skip("uShort", 3);

        // The "unrolled" mapping from character codes to glyph indices.
        cmap.glyphIndexMap = {};
        var endCountParser = new parse.Parser(data, start + offset + 14);
        var startCountParser = new parse.Parser(
          data,
          start + offset + 16 + segCount * 2
        );
        var idDeltaParser = new parse.Parser(
          data,
          start + offset + 16 + segCount * 4
        );
        var idRangeOffsetParser = new parse.Parser(
          data,
          start + offset + 16 + segCount * 6
        );
        var glyphIndexOffset = start + offset + 16 + segCount * 8;
        for (var i = 0; i < segCount - 1; i += 1) {
          var glyphIndex = void 0;
          var endCount = endCountParser.parseUShort();
          var startCount = startCountParser.parseUShort();
          var idDelta = idDeltaParser.parseShort();
          var idRangeOffset = idRangeOffsetParser.parseUShort();
          for (var c = startCount; c <= endCount; c += 1) {
            if (idRangeOffset !== 0) {
              // The idRangeOffset is relative to the current position in the idRangeOffset array.
              // Take the current offset in the idRangeOffset array.
              glyphIndexOffset =
                idRangeOffsetParser.offset +
                idRangeOffsetParser.relativeOffset -
                2;

              // Add the value of the idRangeOffset, which will move us into the glyphIndex array.
              glyphIndexOffset += idRangeOffset;

              // Then add the character index of the current segment, multiplied by 2 for USHORTs.
              glyphIndexOffset += (c - startCount) * 2;
              glyphIndex = parse.getUShort(data, glyphIndexOffset);
              if (glyphIndex !== 0) {
                glyphIndex = (glyphIndex + idDelta) & 0xffff;
              }
            } else {
              glyphIndex = (c + idDelta) & 0xffff;
            }

            cmap.glyphIndexMap[c] = glyphIndex;
          }
        }
      }

      // Parse the \`cmap\` table. This table stores the mappings from characters to glyphs.
      // There are many available formats, but we only support the Windows format 4 and 12.
      // This function returns a \`CmapEncoding\` object or null if no supported format could be found.
      function parseCmapTable(data, start) {
        var cmap = {};
        cmap.version = parse.getUShort(data, start);
        check.argument(cmap.version === 0, "cmap table version should be 0.");

        // The cmap table can contain many sub-tables, each with their own format.
        // We're only interested in a "platform 0" (Unicode format) and "platform 3" (Windows format) table.
        cmap.numTables = parse.getUShort(data, start + 2);
        var offset = -1;
        for (var i = cmap.numTables - 1; i >= 0; i -= 1) {
          var platformId = parse.getUShort(data, start + 4 + i * 8);
          var encodingId = parse.getUShort(data, start + 4 + i * 8 + 2);
          if (
            (platformId === 3 &&
              (encodingId === 0 || encodingId === 1 || encodingId === 10)) ||
            (platformId === 0 &&
              (encodingId === 0 ||
                encodingId === 1 ||
                encodingId === 2 ||
                encodingId === 3 ||
                encodingId === 4))
          ) {
            offset = parse.getULong(data, start + 4 + i * 8 + 4);
            break;
          }
        }

        if (offset === -1) {
          // There is no cmap table in the font that we support.
          throw new Error("No valid cmap sub-tables found.");
        }

        var p = new parse.Parser(data, start + offset);
        cmap.format = p.parseUShort();

        if (cmap.format === 12) {
          parseCmapTableFormat12(cmap, p);
        } else if (cmap.format === 4) {
          parseCmapTableFormat4(cmap, p, data, start, offset);
        } else {
          throw new Error(
            "Only format 4 and 12 cmap tables are supported (found format " +
              cmap.format +
              ")."
          );
        }

        return cmap;
      }

      function addSegment(t, code, glyphIndex) {
        t.segments.push({
          end: code,
          start: code,
          delta: -(code - glyphIndex),
          offset: 0,
          glyphIndex: glyphIndex,
        });
      }

      function addTerminatorSegment(t) {
        t.segments.push({
          end: 0xffff,
          start: 0xffff,
          delta: 1,
          offset: 0,
        });
      }

      // Make cmap table, format 4 by default, 12 if needed only
      function makeCmapTable(glyphs) {
        // Plan 0 is the base Unicode Plan but emojis, for example are on another plan, and needs cmap 12 format (with 32bit)
        var isPlan0Only = true;
        var i;

        // Check if we need to add cmap format 12 or if format 4 only is fine
        for (i = glyphs.length - 1; i > 0; i -= 1) {
          var g = glyphs.get(i);
          if (g.unicode > 65535) {
            console.log("Adding CMAP format 12 (needed!)");
            isPlan0Only = false;
            break;
          }
        }

        var cmapTable = [
          { name: "version", type: "USHORT", value: 0 },
          { name: "numTables", type: "USHORT", value: isPlan0Only ? 1 : 2 },

          // CMAP 4 header
          { name: "platformID", type: "USHORT", value: 3 },
          { name: "encodingID", type: "USHORT", value: 1 },
          { name: "offset", type: "ULONG", value: isPlan0Only ? 12 : 12 + 8 },
        ];

        if (!isPlan0Only) {
          cmapTable = cmapTable.concat([
            // CMAP 12 header
            { name: "cmap12PlatformID", type: "USHORT", value: 3 }, // We encode only for PlatformID = 3 (Windows) because it is supported everywhere
            { name: "cmap12EncodingID", type: "USHORT", value: 10 },
            { name: "cmap12Offset", type: "ULONG", value: 0 },
          ]);
        }

        cmapTable = cmapTable.concat([
          // CMAP 4 Subtable
          { name: "format", type: "USHORT", value: 4 },
          { name: "cmap4Length", type: "USHORT", value: 0 },
          { name: "language", type: "USHORT", value: 0 },
          { name: "segCountX2", type: "USHORT", value: 0 },
          { name: "searchRange", type: "USHORT", value: 0 },
          { name: "entrySelector", type: "USHORT", value: 0 },
          { name: "rangeShift", type: "USHORT", value: 0 },
        ]);

        var t = new table.Table("cmap", cmapTable);

        t.segments = [];
        for (i = 0; i < glyphs.length; i += 1) {
          var glyph = glyphs.get(i);
          for (var j = 0; j < glyph.unicodes.length; j += 1) {
            addSegment(t, glyph.unicodes[j], i);
          }

          t.segments = t.segments.sort(function (a, b) {
            return a.start - b.start;
          });
        }

        addTerminatorSegment(t);

        var segCount = t.segments.length;
        var segCountToRemove = 0;

        // CMAP 4
        // Set up parallel segment arrays.
        var endCounts = [];
        var startCounts = [];
        var idDeltas = [];
        var idRangeOffsets = [];
        var glyphIds = [];

        // CMAP 12
        var cmap12Groups = [];

        // Reminder this loop is not following the specification at 100%
        // The specification -> find suites of characters and make a group
        // Here we're doing one group for each letter
        // Doing as the spec can save 8 times (or more) space
        for (i = 0; i < segCount; i += 1) {
          var segment = t.segments[i];

          // CMAP 4
          if (segment.end <= 65535 && segment.start <= 65535) {
            endCounts = endCounts.concat({
              name: "end_" + i,
              type: "USHORT",
              value: segment.end,
            });
            startCounts = startCounts.concat({
              name: "start_" + i,
              type: "USHORT",
              value: segment.start,
            });
            idDeltas = idDeltas.concat({
              name: "idDelta_" + i,
              type: "SHORT",
              value: segment.delta,
            });
            idRangeOffsets = idRangeOffsets.concat({
              name: "idRangeOffset_" + i,
              type: "USHORT",
              value: segment.offset,
            });
            if (segment.glyphId !== undefined) {
              glyphIds = glyphIds.concat({
                name: "glyph_" + i,
                type: "USHORT",
                value: segment.glyphId,
              });
            }
          } else {
            // Skip Unicode > 65535 (16bit unsigned max) for CMAP 4, will be added in CMAP 12
            segCountToRemove += 1;
          }

          // CMAP 12
          // Skip Terminator Segment
          if (!isPlan0Only && segment.glyphIndex !== undefined) {
            cmap12Groups = cmap12Groups.concat({
              name: "cmap12Start_" + i,
              type: "ULONG",
              value: segment.start,
            });
            cmap12Groups = cmap12Groups.concat({
              name: "cmap12End_" + i,
              type: "ULONG",
              value: segment.end,
            });
            cmap12Groups = cmap12Groups.concat({
              name: "cmap12Glyph_" + i,
              type: "ULONG",
              value: segment.glyphIndex,
            });
          }
        }

        // CMAP 4 Subtable
        t.segCountX2 = (segCount - segCountToRemove) * 2;
        t.searchRange =
          Math.pow(
            2,
            Math.floor(Math.log(segCount - segCountToRemove) / Math.log(2))
          ) * 2;
        t.entrySelector = Math.log(t.searchRange / 2) / Math.log(2);
        t.rangeShift = t.segCountX2 - t.searchRange;

        t.fields = t.fields.concat(endCounts);
        t.fields.push({ name: "reservedPad", type: "USHORT", value: 0 });
        t.fields = t.fields.concat(startCounts);
        t.fields = t.fields.concat(idDeltas);
        t.fields = t.fields.concat(idRangeOffsets);
        t.fields = t.fields.concat(glyphIds);

        t.cmap4Length =
          14 + // Subtable header
          endCounts.length * 2 +
          2 + // reservedPad
          startCounts.length * 2 +
          idDeltas.length * 2 +
          idRangeOffsets.length * 2 +
          glyphIds.length * 2;

        if (!isPlan0Only) {
          // CMAP 12 Subtable
          var cmap12Length =
            16 + // Subtable header
            cmap12Groups.length * 4;

          t.cmap12Offset = 12 + 2 * 2 + 4 + t.cmap4Length;
          t.fields = t.fields.concat([
            { name: "cmap12Format", type: "USHORT", value: 12 },
            { name: "cmap12Reserved", type: "USHORT", value: 0 },
            { name: "cmap12Length", type: "ULONG", value: cmap12Length },
            { name: "cmap12Language", type: "ULONG", value: 0 },
            {
              name: "cmap12nGroups",
              type: "ULONG",
              value: cmap12Groups.length / 3,
            },
          ]);

          t.fields = t.fields.concat(cmap12Groups);
        }

        return t;
      }

      var cmap = { parse: parseCmapTable, make: makeCmapTable };

      // Glyph encoding

      var cffStandardStrings = [
        ".notdef",
        "space",
        "exclam",
        "quotedbl",
        "numbersign",
        "dollar",
        "percent",
        "ampersand",
        "quoteright",
        "parenleft",
        "parenright",
        "asterisk",
        "plus",
        "comma",
        "hyphen",
        "period",
        "slash",
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "colon",
        "semicolon",
        "less",
        "equal",
        "greater",
        "question",
        "at",
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "W",
        "X",
        "Y",
        "Z",
        "bracketleft",
        "backslash",
        "bracketright",
        "asciicircum",
        "underscore",
        "quoteleft",
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "w",
        "x",
        "y",
        "z",
        "braceleft",
        "bar",
        "braceright",
        "asciitilde",
        "exclamdown",
        "cent",
        "sterling",
        "fraction",
        "yen",
        "florin",
        "section",
        "currency",
        "quotesingle",
        "quotedblleft",
        "guillemotleft",
        "guilsinglleft",
        "guilsinglright",
        "fi",
        "fl",
        "endash",
        "dagger",
        "daggerdbl",
        "periodcentered",
        "paragraph",
        "bullet",
        "quotesinglbase",
        "quotedblbase",
        "quotedblright",
        "guillemotright",
        "ellipsis",
        "perthousand",
        "questiondown",
        "grave",
        "acute",
        "circumflex",
        "tilde",
        "macron",
        "breve",
        "dotaccent",
        "dieresis",
        "ring",
        "cedilla",
        "hungarumlaut",
        "ogonek",
        "caron",
        "emdash",
        "AE",
        "ordfeminine",
        "Lslash",
        "Oslash",
        "OE",
        "ordmasculine",
        "ae",
        "dotlessi",
        "lslash",
        "oslash",
        "oe",
        "germandbls",
        "onesuperior",
        "logicalnot",
        "mu",
        "trademark",
        "Eth",
        "onehalf",
        "plusminus",
        "Thorn",
        "onequarter",
        "divide",
        "brokenbar",
        "degree",
        "thorn",
        "threequarters",
        "twosuperior",
        "registered",
        "minus",
        "eth",
        "multiply",
        "threesuperior",
        "copyright",
        "Aacute",
        "Acircumflex",
        "Adieresis",
        "Agrave",
        "Aring",
        "Atilde",
        "Ccedilla",
        "Eacute",
        "Ecircumflex",
        "Edieresis",
        "Egrave",
        "Iacute",
        "Icircumflex",
        "Idieresis",
        "Igrave",
        "Ntilde",
        "Oacute",
        "Ocircumflex",
        "Odieresis",
        "Ograve",
        "Otilde",
        "Scaron",
        "Uacute",
        "Ucircumflex",
        "Udieresis",
        "Ugrave",
        "Yacute",
        "Ydieresis",
        "Zcaron",
        "aacute",
        "acircumflex",
        "adieresis",
        "agrave",
        "aring",
        "atilde",
        "ccedilla",
        "eacute",
        "ecircumflex",
        "edieresis",
        "egrave",
        "iacute",
        "icircumflex",
        "idieresis",
        "igrave",
        "ntilde",
        "oacute",
        "ocircumflex",
        "odieresis",
        "ograve",
        "otilde",
        "scaron",
        "uacute",
        "ucircumflex",
        "udieresis",
        "ugrave",
        "yacute",
        "ydieresis",
        "zcaron",
        "exclamsmall",
        "Hungarumlautsmall",
        "dollaroldstyle",
        "dollarsuperior",
        "ampersandsmall",
        "Acutesmall",
        "parenleftsuperior",
        "parenrightsuperior",
        "266 ff",
        "onedotenleader",
        "zerooldstyle",
        "oneoldstyle",
        "twooldstyle",
        "threeoldstyle",
        "fouroldstyle",
        "fiveoldstyle",
        "sixoldstyle",
        "sevenoldstyle",
        "eightoldstyle",
        "nineoldstyle",
        "commasuperior",
        "threequartersemdash",
        "periodsuperior",
        "questionsmall",
        "asuperior",
        "bsuperior",
        "centsuperior",
        "dsuperior",
        "esuperior",
        "isuperior",
        "lsuperior",
        "msuperior",
        "nsuperior",
        "osuperior",
        "rsuperior",
        "ssuperior",
        "tsuperior",
        "ff",
        "ffi",
        "ffl",
        "parenleftinferior",
        "parenrightinferior",
        "Circumflexsmall",
        "hyphensuperior",
        "Gravesmall",
        "Asmall",
        "Bsmall",
        "Csmall",
        "Dsmall",
        "Esmall",
        "Fsmall",
        "Gsmall",
        "Hsmall",
        "Ismall",
        "Jsmall",
        "Ksmall",
        "Lsmall",
        "Msmall",
        "Nsmall",
        "Osmall",
        "Psmall",
        "Qsmall",
        "Rsmall",
        "Ssmall",
        "Tsmall",
        "Usmall",
        "Vsmall",
        "Wsmall",
        "Xsmall",
        "Ysmall",
        "Zsmall",
        "colonmonetary",
        "onefitted",
        "rupiah",
        "Tildesmall",
        "exclamdownsmall",
        "centoldstyle",
        "Lslashsmall",
        "Scaronsmall",
        "Zcaronsmall",
        "Dieresissmall",
        "Brevesmall",
        "Caronsmall",
        "Dotaccentsmall",
        "Macronsmall",
        "figuredash",
        "hypheninferior",
        "Ogoneksmall",
        "Ringsmall",
        "Cedillasmall",
        "questiondownsmall",
        "oneeighth",
        "threeeighths",
        "fiveeighths",
        "seveneighths",
        "onethird",
        "twothirds",
        "zerosuperior",
        "foursuperior",
        "fivesuperior",
        "sixsuperior",
        "sevensuperior",
        "eightsuperior",
        "ninesuperior",
        "zeroinferior",
        "oneinferior",
        "twoinferior",
        "threeinferior",
        "fourinferior",
        "fiveinferior",
        "sixinferior",
        "seveninferior",
        "eightinferior",
        "nineinferior",
        "centinferior",
        "dollarinferior",
        "periodinferior",
        "commainferior",
        "Agravesmall",
        "Aacutesmall",
        "Acircumflexsmall",
        "Atildesmall",
        "Adieresissmall",
        "Aringsmall",
        "AEsmall",
        "Ccedillasmall",
        "Egravesmall",
        "Eacutesmall",
        "Ecircumflexsmall",
        "Edieresissmall",
        "Igravesmall",
        "Iacutesmall",
        "Icircumflexsmall",
        "Idieresissmall",
        "Ethsmall",
        "Ntildesmall",
        "Ogravesmall",
        "Oacutesmall",
        "Ocircumflexsmall",
        "Otildesmall",
        "Odieresissmall",
        "OEsmall",
        "Oslashsmall",
        "Ugravesmall",
        "Uacutesmall",
        "Ucircumflexsmall",
        "Udieresissmall",
        "Yacutesmall",
        "Thornsmall",
        "Ydieresissmall",
        "001.000",
        "001.001",
        "001.002",
        "001.003",
        "Black",
        "Bold",
        "Book",
        "Light",
        "Medium",
        "Regular",
        "Roman",
        "Semibold",
      ];

      var cffStandardEncoding = [
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "space",
        "exclam",
        "quotedbl",
        "numbersign",
        "dollar",
        "percent",
        "ampersand",
        "quoteright",
        "parenleft",
        "parenright",
        "asterisk",
        "plus",
        "comma",
        "hyphen",
        "period",
        "slash",
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "colon",
        "semicolon",
        "less",
        "equal",
        "greater",
        "question",
        "at",
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "W",
        "X",
        "Y",
        "Z",
        "bracketleft",
        "backslash",
        "bracketright",
        "asciicircum",
        "underscore",
        "quoteleft",
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "w",
        "x",
        "y",
        "z",
        "braceleft",
        "bar",
        "braceright",
        "asciitilde",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "exclamdown",
        "cent",
        "sterling",
        "fraction",
        "yen",
        "florin",
        "section",
        "currency",
        "quotesingle",
        "quotedblleft",
        "guillemotleft",
        "guilsinglleft",
        "guilsinglright",
        "fi",
        "fl",
        "",
        "endash",
        "dagger",
        "daggerdbl",
        "periodcentered",
        "",
        "paragraph",
        "bullet",
        "quotesinglbase",
        "quotedblbase",
        "quotedblright",
        "guillemotright",
        "ellipsis",
        "perthousand",
        "",
        "questiondown",
        "",
        "grave",
        "acute",
        "circumflex",
        "tilde",
        "macron",
        "breve",
        "dotaccent",
        "dieresis",
        "",
        "ring",
        "cedilla",
        "",
        "hungarumlaut",
        "ogonek",
        "caron",
        "emdash",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "AE",
        "",
        "ordfeminine",
        "",
        "",
        "",
        "",
        "Lslash",
        "Oslash",
        "OE",
        "ordmasculine",
        "",
        "",
        "",
        "",
        "",
        "ae",
        "",
        "",
        "",
        "dotlessi",
        "",
        "",
        "lslash",
        "oslash",
        "oe",
        "germandbls",
      ];

      var cffExpertEncoding = [
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "space",
        "exclamsmall",
        "Hungarumlautsmall",
        "",
        "dollaroldstyle",
        "dollarsuperior",
        "ampersandsmall",
        "Acutesmall",
        "parenleftsuperior",
        "parenrightsuperior",
        "twodotenleader",
        "onedotenleader",
        "comma",
        "hyphen",
        "period",
        "fraction",
        "zerooldstyle",
        "oneoldstyle",
        "twooldstyle",
        "threeoldstyle",
        "fouroldstyle",
        "fiveoldstyle",
        "sixoldstyle",
        "sevenoldstyle",
        "eightoldstyle",
        "nineoldstyle",
        "colon",
        "semicolon",
        "commasuperior",
        "threequartersemdash",
        "periodsuperior",
        "questionsmall",
        "",
        "asuperior",
        "bsuperior",
        "centsuperior",
        "dsuperior",
        "esuperior",
        "",
        "",
        "isuperior",
        "",
        "",
        "lsuperior",
        "msuperior",
        "nsuperior",
        "osuperior",
        "",
        "",
        "rsuperior",
        "ssuperior",
        "tsuperior",
        "",
        "ff",
        "fi",
        "fl",
        "ffi",
        "ffl",
        "parenleftinferior",
        "",
        "parenrightinferior",
        "Circumflexsmall",
        "hyphensuperior",
        "Gravesmall",
        "Asmall",
        "Bsmall",
        "Csmall",
        "Dsmall",
        "Esmall",
        "Fsmall",
        "Gsmall",
        "Hsmall",
        "Ismall",
        "Jsmall",
        "Ksmall",
        "Lsmall",
        "Msmall",
        "Nsmall",
        "Osmall",
        "Psmall",
        "Qsmall",
        "Rsmall",
        "Ssmall",
        "Tsmall",
        "Usmall",
        "Vsmall",
        "Wsmall",
        "Xsmall",
        "Ysmall",
        "Zsmall",
        "colonmonetary",
        "onefitted",
        "rupiah",
        "Tildesmall",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "exclamdownsmall",
        "centoldstyle",
        "Lslashsmall",
        "",
        "",
        "Scaronsmall",
        "Zcaronsmall",
        "Dieresissmall",
        "Brevesmall",
        "Caronsmall",
        "",
        "Dotaccentsmall",
        "",
        "",
        "Macronsmall",
        "",
        "",
        "figuredash",
        "hypheninferior",
        "",
        "",
        "Ogoneksmall",
        "Ringsmall",
        "Cedillasmall",
        "",
        "",
        "",
        "onequarter",
        "onehalf",
        "threequarters",
        "questiondownsmall",
        "oneeighth",
        "threeeighths",
        "fiveeighths",
        "seveneighths",
        "onethird",
        "twothirds",
        "",
        "",
        "zerosuperior",
        "onesuperior",
        "twosuperior",
        "threesuperior",
        "foursuperior",
        "fivesuperior",
        "sixsuperior",
        "sevensuperior",
        "eightsuperior",
        "ninesuperior",
        "zeroinferior",
        "oneinferior",
        "twoinferior",
        "threeinferior",
        "fourinferior",
        "fiveinferior",
        "sixinferior",
        "seveninferior",
        "eightinferior",
        "nineinferior",
        "centinferior",
        "dollarinferior",
        "periodinferior",
        "commainferior",
        "Agravesmall",
        "Aacutesmall",
        "Acircumflexsmall",
        "Atildesmall",
        "Adieresissmall",
        "Aringsmall",
        "AEsmall",
        "Ccedillasmall",
        "Egravesmall",
        "Eacutesmall",
        "Ecircumflexsmall",
        "Edieresissmall",
        "Igravesmall",
        "Iacutesmall",
        "Icircumflexsmall",
        "Idieresissmall",
        "Ethsmall",
        "Ntildesmall",
        "Ogravesmall",
        "Oacutesmall",
        "Ocircumflexsmall",
        "Otildesmall",
        "Odieresissmall",
        "OEsmall",
        "Oslashsmall",
        "Ugravesmall",
        "Uacutesmall",
        "Ucircumflexsmall",
        "Udieresissmall",
        "Yacutesmall",
        "Thornsmall",
        "Ydieresissmall",
      ];

      var standardNames = [
        ".notdef",
        ".null",
        "nonmarkingreturn",
        "space",
        "exclam",
        "quotedbl",
        "numbersign",
        "dollar",
        "percent",
        "ampersand",
        "quotesingle",
        "parenleft",
        "parenright",
        "asterisk",
        "plus",
        "comma",
        "hyphen",
        "period",
        "slash",
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "colon",
        "semicolon",
        "less",
        "equal",
        "greater",
        "question",
        "at",
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "W",
        "X",
        "Y",
        "Z",
        "bracketleft",
        "backslash",
        "bracketright",
        "asciicircum",
        "underscore",
        "grave",
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "w",
        "x",
        "y",
        "z",
        "braceleft",
        "bar",
        "braceright",
        "asciitilde",
        "Adieresis",
        "Aring",
        "Ccedilla",
        "Eacute",
        "Ntilde",
        "Odieresis",
        "Udieresis",
        "aacute",
        "agrave",
        "acircumflex",
        "adieresis",
        "atilde",
        "aring",
        "ccedilla",
        "eacute",
        "egrave",
        "ecircumflex",
        "edieresis",
        "iacute",
        "igrave",
        "icircumflex",
        "idieresis",
        "ntilde",
        "oacute",
        "ograve",
        "ocircumflex",
        "odieresis",
        "otilde",
        "uacute",
        "ugrave",
        "ucircumflex",
        "udieresis",
        "dagger",
        "degree",
        "cent",
        "sterling",
        "section",
        "bullet",
        "paragraph",
        "germandbls",
        "registered",
        "copyright",
        "trademark",
        "acute",
        "dieresis",
        "notequal",
        "AE",
        "Oslash",
        "infinity",
        "plusminus",
        "lessequal",
        "greaterequal",
        "yen",
        "mu",
        "partialdiff",
        "summation",
        "product",
        "pi",
        "integral",
        "ordfeminine",
        "ordmasculine",
        "Omega",
        "ae",
        "oslash",
        "questiondown",
        "exclamdown",
        "logicalnot",
        "radical",
        "florin",
        "approxequal",
        "Delta",
        "guillemotleft",
        "guillemotright",
        "ellipsis",
        "nonbreakingspace",
        "Agrave",
        "Atilde",
        "Otilde",
        "OE",
        "oe",
        "endash",
        "emdash",
        "quotedblleft",
        "quotedblright",
        "quoteleft",
        "quoteright",
        "divide",
        "lozenge",
        "ydieresis",
        "Ydieresis",
        "fraction",
        "currency",
        "guilsinglleft",
        "guilsinglright",
        "fi",
        "fl",
        "daggerdbl",
        "periodcentered",
        "quotesinglbase",
        "quotedblbase",
        "perthousand",
        "Acircumflex",
        "Ecircumflex",
        "Aacute",
        "Edieresis",
        "Egrave",
        "Iacute",
        "Icircumflex",
        "Idieresis",
        "Igrave",
        "Oacute",
        "Ocircumflex",
        "apple",
        "Ograve",
        "Uacute",
        "Ucircumflex",
        "Ugrave",
        "dotlessi",
        "circumflex",
        "tilde",
        "macron",
        "breve",
        "dotaccent",
        "ring",
        "cedilla",
        "hungarumlaut",
        "ogonek",
        "caron",
        "Lslash",
        "lslash",
        "Scaron",
        "scaron",
        "Zcaron",
        "zcaron",
        "brokenbar",
        "Eth",
        "eth",
        "Yacute",
        "yacute",
        "Thorn",
        "thorn",
        "minus",
        "multiply",
        "onesuperior",
        "twosuperior",
        "threesuperior",
        "onehalf",
        "onequarter",
        "threequarters",
        "franc",
        "Gbreve",
        "gbreve",
        "Idotaccent",
        "Scedilla",
        "scedilla",
        "Cacute",
        "cacute",
        "Ccaron",
        "ccaron",
        "dcroat",
      ];

      /**
       * This is the encoding used for fonts created from scratch.
       * It loops through all glyphs and finds the appropriate unicode value.
       * Since it's linear time, other encodings will be faster.
       * @exports opentype.DefaultEncoding
       * @class
       * @constructor
       * @param {opentype.Font}
       */
      function DefaultEncoding(font) {
        this.font = font;
      }

      DefaultEncoding.prototype.charToGlyphIndex = function (c) {
        var code = c.codePointAt(0);
        var glyphs = this.font.glyphs;
        if (glyphs) {
          for (var i = 0; i < glyphs.length; i += 1) {
            var glyph = glyphs.get(i);
            for (var j = 0; j < glyph.unicodes.length; j += 1) {
              if (glyph.unicodes[j] === code) {
                return i;
              }
            }
          }
        }
        return null;
      };

      /**
       * @exports opentype.CmapEncoding
       * @class
       * @constructor
       * @param {Object} cmap - a object with the cmap encoded data
       */
      function CmapEncoding(cmap) {
        this.cmap = cmap;
      }

      /**
       * @param  {string} c - the character
       * @return {number} The glyph index.
       */
      CmapEncoding.prototype.charToGlyphIndex = function (c) {
        return this.cmap.glyphIndexMap[c.codePointAt(0)] || 0;
      };

      /**
       * @exports opentype.CffEncoding
       * @class
       * @constructor
       * @param {string} encoding - The encoding
       * @param {Array} charset - The character set.
       */
      function CffEncoding(encoding, charset) {
        this.encoding = encoding;
        this.charset = charset;
      }

      /**
       * @param  {string} s - The character
       * @return {number} The index.
       */
      CffEncoding.prototype.charToGlyphIndex = function (s) {
        var code = s.codePointAt(0);
        var charName = this.encoding[code];
        return this.charset.indexOf(charName);
      };

      /**
       * @exports opentype.GlyphNames
       * @class
       * @constructor
       * @param {Object} post
       */
      function GlyphNames(post) {
        var this$1 = this;

        switch (post.version) {
          case 1:
            this.names = standardNames.slice();
            break;
          case 2:
            this.names = new Array(post.numberOfGlyphs);
            for (var i = 0; i < post.numberOfGlyphs; i++) {
              if (post.glyphNameIndex[i] < standardNames.length) {
                this$1.names[i] = standardNames[post.glyphNameIndex[i]];
              } else {
                this$1.names[i] =
                  post.names[post.glyphNameIndex[i] - standardNames.length];
              }
            }

            break;
          case 2.5:
            this.names = new Array(post.numberOfGlyphs);
            for (var i$1 = 0; i$1 < post.numberOfGlyphs; i$1++) {
              this$1.names[i$1] = standardNames[i$1 + post.glyphNameIndex[i$1]];
            }

            break;
          case 3:
            this.names = [];
            break;
          default:
            this.names = [];
            break;
        }
      }

      /**
       * Gets the index of a glyph by name.
       * @param  {string} name - The glyph name
       * @return {number} The index
       */
      GlyphNames.prototype.nameToGlyphIndex = function (name) {
        return this.names.indexOf(name);
      };

      /**
       * @param  {number} gid
       * @return {string}
       */
      GlyphNames.prototype.glyphIndexToName = function (gid) {
        return this.names[gid];
      };

      /**
       * @alias opentype.addGlyphNames
       * @param {opentype.Font}
       */
      function addGlyphNames(font) {
        var glyph;
        var glyphIndexMap = font.tables.cmap.glyphIndexMap;
        var charCodes = Object.keys(glyphIndexMap);

        for (var i = 0; i < charCodes.length; i += 1) {
          var c = charCodes[i];
          var glyphIndex = glyphIndexMap[c];
          glyph = font.glyphs.get(glyphIndex);
          glyph.addUnicode(parseInt(c));
        }

        for (var i$1 = 0; i$1 < font.glyphs.length; i$1 += 1) {
          glyph = font.glyphs.get(i$1);
          if (font.cffEncoding) {
            if (font.isCIDFont) {
              glyph.name = "gid" + i$1;
            } else {
              glyph.name = font.cffEncoding.charset[i$1];
            }
          } else if (font.glyphNames.names) {
            glyph.name = font.glyphNames.glyphIndexToName(i$1);
          }
        }
      }

      // Drawing utility functions.

      // Draw a line on the given context from point \`x1,y1\` to point \`x2,y2\`.
      function line(ctx, x1, y1, x2, y2) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      var draw = { line: line };

      // The Glyph object
      // import glyf from './tables/glyf' Can't be imported here, because it's a circular dependency

      function getPathDefinition(glyph, path) {
        var _path = path || new Path();
        return {
          configurable: true,

          get: function () {
            if (typeof _path === "function") {
              _path = _path();
            }

            return _path;
          },

          set: function (p) {
            _path = p;
          },
        };
      }
      /**
       * @typedef GlyphOptions
       * @type Object
       * @property {string} [name] - The glyph name
       * @property {number} [unicode]
       * @property {Array} [unicodes]
       * @property {number} [xMin]
       * @property {number} [yMin]
       * @property {number} [xMax]
       * @property {number} [yMax]
       * @property {number} [advanceWidth]
       */

      // A Glyph is an individual mark that often corresponds to a character.
      // Some glyphs, such as ligatures, are a combination of many characters.
      // Glyphs are the basic building blocks of a font.
      //
      // The \`Glyph\` class contains utility methods for drawing the path and its points.
      /**
       * @exports opentype.Glyph
       * @class
       * @param {GlyphOptions}
       * @constructor
       */
      function Glyph(options) {
        // By putting all the code on a prototype function (which is only declared once)
        // we reduce the memory requirements for larger fonts by some 2%
        this.bindConstructorValues(options);
      }

      /**
       * @param  {GlyphOptions}
       */
      Glyph.prototype.bindConstructorValues = function (options) {
        this.index = options.index || 0;

        // These three values cannot be deferred for memory optimization:
        this.name = options.name || null;
        this.unicode = options.unicode || undefined;
        this.unicodes =
          options.unicodes || options.unicode !== undefined
            ? [options.unicode]
            : [];

        // But by binding these values only when necessary, we reduce can
        // the memory requirements by almost 3% for larger fonts.
        if (options.xMin) {
          this.xMin = options.xMin;
        }

        if (options.yMin) {
          this.yMin = options.yMin;
        }

        if (options.xMax) {
          this.xMax = options.xMax;
        }

        if (options.yMax) {
          this.yMax = options.yMax;
        }

        if (options.advanceWidth) {
          this.advanceWidth = options.advanceWidth;
        }

        // The path for a glyph is the most memory intensive, and is bound as a value
        // with a getter/setter to ensure we actually do path parsing only once the
        // path is actually needed by anything.
        Object.defineProperty(
          this,
          "path",
          getPathDefinition(this, options.path)
        );
      };

      /**
       * @param {number}
       */
      Glyph.prototype.addUnicode = function (unicode) {
        if (this.unicodes.length === 0) {
          this.unicode = unicode;
        }

        this.unicodes.push(unicode);
      };

      /**
       * Calculate the minimum bounding box for this glyph.
       * @return {opentype.BoundingBox}
       */
      Glyph.prototype.getBoundingBox = function () {
        return this.path.getBoundingBox();
      };

      /**
       * Convert the glyph to a Path we can draw on a drawing context.
       * @param  {number} [x=0] - Horizontal position of the beginning of the text.
       * @param  {number} [y=0] - Vertical position of the *baseline* of the text.
       * @param  {number} [fontSize=72] - Font size in pixels. We scale the glyph units by \`1 / unitsPerEm * fontSize\`.
       * @param  {Object=} options - xScale, yScale to stretch the glyph.
       * @param  {opentype.Font} if hinting is to be used, the font
       * @return {opentype.Path}
       */
      Glyph.prototype.getPath = function (x, y, fontSize, options, font) {
        x = x !== undefined ? x : 0;
        y = y !== undefined ? y : 0;
        fontSize = fontSize !== undefined ? fontSize : 72;
        var commands;
        var hPoints;
        if (!options) {
          options = {};
        }
        var xScale = options.xScale;
        var yScale = options.yScale;

        if (options.hinting && font && font.hinting) {
          // in case of hinting, the hinting engine takes care
          // of scaling the points (not the path) before hinting.
          hPoints = this.path && font.hinting.exec(this, fontSize);
          // in case the hinting engine failed hPoints is undefined
          // and thus reverts to plain rending
        }

        if (hPoints) {
          // Call font.hinting.getCommands instead of \`glyf.getPath(hPoints).commands\` to avoid a circular dependency
          commands = font.hinting.getCommands(hPoints);
          x = Math.round(x);
          y = Math.round(y);
          // TODO in case of hinting xyScaling is not yet supported
          xScale = yScale = 1;
        } else {
          commands = this.path.commands;
          var scale = (1 / this.path.unitsPerEm) * fontSize;
          if (xScale === undefined) {
            xScale = scale;
          }
          if (yScale === undefined) {
            yScale = scale;
          }
        }

        var p = new Path();
        for (var i = 0; i < commands.length; i += 1) {
          var cmd = commands[i];
          if (cmd.type === "M") {
            p.moveTo(x + cmd.x * xScale, y + -cmd.y * yScale);
          } else if (cmd.type === "L") {
            p.lineTo(x + cmd.x * xScale, y + -cmd.y * yScale);
          } else if (cmd.type === "Q") {
            p.quadraticCurveTo(
              x + cmd.x1 * xScale,
              y + -cmd.y1 * yScale,
              x + cmd.x * xScale,
              y + -cmd.y * yScale
            );
          } else if (cmd.type === "C") {
            p.curveTo(
              x + cmd.x1 * xScale,
              y + -cmd.y1 * yScale,
              x + cmd.x2 * xScale,
              y + -cmd.y2 * yScale,
              x + cmd.x * xScale,
              y + -cmd.y * yScale
            );
          } else if (cmd.type === "Z") {
            p.closePath();
          }
        }

        return p;
      };

      /**
       * Split the glyph into contours.
       * This function is here for backwards compatibility, and to
       * provide raw access to the TrueType glyph outlines.
       * @return {Array}
       */
      Glyph.prototype.getContours = function () {
        var this$1 = this;

        if (this.points === undefined) {
          return [];
        }

        var contours = [];
        var currentContour = [];
        for (var i = 0; i < this.points.length; i += 1) {
          var pt = this$1.points[i];
          currentContour.push(pt);
          if (pt.lastPointOfContour) {
            contours.push(currentContour);
            currentContour = [];
          }
        }`
function hl(c) {
  // debugger
  var inp = c.querySelector(".colorful-code");
  var tokens = Colorful.compilers.JS.tokenize(inp.innerText).tokens;
  var markuped = Colorful.compilers.JS.parse(tokens)
  var text = inp.innerText;
  var d1 = window.performance.now();
  var compileTime = window.performance.now() - d1;
  c.innerHTML = Colorful.finishUp(Colorful.config, text, markuped);
  var speed = ((text.length / 1024 / compileTime) * 1000).toFixed(3); //kb/s
  console.log(
    `total code analysed: ${(text.length / 1024).toFixed(3)} kb\nfound: ${
      tokens.length
    } tokens\ncompile time: ${compileTime.toFixed(
      4
    )} ms\ncompile speed: ${speed} kib/s`
  );
}