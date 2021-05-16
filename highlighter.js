const OUTPUT = document.getElementById("output");
String.prototype.reverse = function () {
  return this.split("").reverse().join("");
};
String.prototype.replaceSpecHTMLChars = function () {
  return this.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};
const [
  T_STRING,
  T_KEY,
  T_TEXT,
  T_OPERATOR,
  T_NEWLINE,
  T_COMMENT,
  T_NUMBER,
  T_WS,
  T_FUNCTION,
  T_ARGUMENT,
  T_CAPITAL,
  T_OBJECTPROP,
  T_METHOD,
  T_REGEX,
  T_LPAREN,
  T_NULLTYPE
] = [
  "STRING",
  "KEY",
  "TEXT",
  "OPERATOR",
  "NEWLINE",
  "COMMENT",
  "NUMBER",
  "WS",
  "FUNCTION",
  "ARGUMENT",
  "CAPITAL",
  "OBJECTPROP",
  "METHOD",
  "REGEX",
  "PAREN",
  "NULLTYPE"
];

// RegEx
var KeywordRE =
  /^(arguments|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|eval|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|native|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield)$/;
var operatorRE = /(\=|\+|\-|\*|\/|%|!|<|>|&|\|)*/;
var nameCharRE = /[a-zA-Z0-9_\$]/;
var number = /^((\d*)|(0x[0-9a-f]*)|(0b[01]*))$/;
var nullTypes = /^(null|NaN|undefined)$/;
var commentRE = /((\/\*[\s\S]*?\*\/|\/\*[\s\S]*)|(\/\/.*))/;
var stringRE =
  /('(((\\)+(')?)|([^']))*')|("(((\\)+(")?)|([^"]))*")|(`(((\\)+(`)?)|([^`]))*`)/;
var regexRE =
  /^\/((?![*+?])(?:[^\r\n\[/\\]|\\.|\[(?:[^\r\n\]\\]|\\.)*\])+)\/((?:g(?:im?|mi?)?|i(?:gm?|mg?)?|m(?:gi?|ig?)?)?)/;
var builtInObject =
  /^(AggregateError|Buffer|Array|ArrayBuffer|AsyncFunction|AsyncGenerator|AsyncGeneratorFunction|Atomics|BigInt|BigInt64Array|BigUint64Array|Boolean|DataView|Date|Error|EvalError|Float32Array|Float64Array|Function|Generator|GeneratorFunction|Int16Array|Int32Array|Int8Array|InternalError|Intl|JSON|Map|Math|Number|Object|Promise|Proxy|RangeError|ReferenceError|Reflect|RegExp|Set|SharedArrayBuffer|String|Symbol|SyntaxError|TypeError|URIError|Uint16Array|Uint32Array|Uint8Array|Uint8ClampedArray|WeakMap|WeakSet|WebAssembly)$/;
const NR = document.getElementById("numberRow");
const EDITOR = document.getElementById("editor");

//global variables for functionalities
var lineCount = 1;
var fontSize = 16; // in px
var w_h = 0.5498367766955267; // width÷height of a monospace number
var numberWidth = w_h * fontSize;
document
  .querySelector(":root")
  .style.setProperty("--fontSize", fontSize + "px");
function highlight(container, text) {
  var lineCount = (text.match(/\n/g)?.length || 0) + 1;
  var d1 = window.performance.now();
  tokens = tokenise(text);
  var markuped = parse(tokens);
  var dt = window.performance.now() - d1;
  var lineNo = new Array(lineCount).fill(1);
  lineNo.forEach((k, i) => {
    lineNo[i] = "<span class='intent'>" + (i + 1) + "</span>";
  });
  NR.innerHTML = lineNo.join("\n");
  document
    .querySelector(":root")
    .style.setProperty(
      "--intent-width",
      String(lineCount).length * numberWidth + "px"
    );
  container.innerHTML = markuped;
  var speed = len / dt; //b/ms
  console.log(`run time = ${dt} ms
analysed: ${Math.round(len / 1.024) / 1000}kb input (@ ${
    Math.round(speed * 1000) / 1000
  } kb/s)
found: ${tokens.length} tokens
`);
  return tokens;
}

function tokenise(text) {
  len = text.length;
  var tokens = [],
    word = "";

  for (var i = 0; i < len; i++) {
    var char = text[i];
    // debugger
    if (!char.match(nameCharRE)) {
      // word analysis
      if (word != "") {
        tokens.push(readWordToken(word));
        //  mergeTextTypes();
      }
      var next2 = text.substring(i, i + 2);
      // analysin various symbols

      if (char == "\n") {
        tokens.push({type: T_NEWLINE});
      } else if (next2 == "//" || next2 == "/*") {
        // comment
        var comment = text.substring(i, len).match(commentRE)[0];
        i += comment.length - 1;
        comment = comment.replaceSpecHTMLChars().split("\n");
        comment.forEach((line, index) => {
          tokens.push({ type: T_COMMENT, token: line});
          if (index < comment.length-1) tokens.push({ type: T_NEWLINE});
        });
        // tokens.push({ type: T_COMMENT, token: d});
      } else if (char.match(/['"`]/)) {
        var str = text.substring(i, len).match(stringRE)[0];
        i += str.length - 1;
        tokens.push({ type: T_STRING, token: str.replaceSpecHTMLChars() });
      } else if (char.match(operatorRE)[0]) {
        // math operators
        if (char == "/") {
          var re = text.substring(i, len).match(regexRE);
          if (re) {
            tokens.push({ type: T_REGEX, token: re[0] });
            i += re[0].length;
          }
        }
        var operStr = text.substring(i).match(operatorRE)[0];
        i += operStr.length - 1;
        tokens.push({
          type: T_OPERATOR,
          token: operStr.replaceSpecHTMLChars(),
        });
      } else if (char == "(") {
        // function name
        var tl = tokens.length;
        var prev = tokens[tl - 1];
        var prevt = prev.token || "";
        var pprev = tokens[tl - 2];
        var ppprev = tokens[tl - 3];
        tokens.push({ type: T_LPAREN, token: "(" });
        const isFunctionClause =
          prevt == "function" ||
          pprev?.token == "function" ||
          ppprev?.token == "function";
        // pppprev?.token == "function";
        /** if following condition is true then it would be function clause
         * cases:
         * 1: function name (args)
         * 2: function name(args)
         * 3: function (args)
         * 4: function(args)
         */
        if (isFunctionClause) {
          // makes name of function colored to method
          if (prev.type == T_TEXT && prevt.match(nameCharRE)) {
            prev.type = T_METHOD;
          } else if (pprev?.type == T_TEXT && pprev.token.match(nameCharRE)) {
            pprev.type = T_METHOD;
          }

          // reads arguments
          if (next2 != "()") {
            [args, i] = readArgumentsToken(i);
            tokens = tokens.concat(args);
          }
        } else if (
          prevt.match(nameCharRE) &&
          /[a-zA-Z0-9_$\s]+/.test(
            (prevt.reverse().match(/^(\s)*[a-zA-Z0-9_$\s]+/) || [""])[0]
          )
        ) {
          //this is function calling clause
          if (prev.type.match(/(TEXT|OBJECTPROP)/) && prevt.match(nameCharRE)) {
            prev.type = T_FUNCTION;
          } else if (
            pprev?.type.match(/(TEXT|OBJECTPROP)/) &&
            pprev.token.match(nameCharRE)
          ) {
            pprev.type = T_FUNCTION;
          } else if (
            ppprev?.type.match(/(TEXT|OBJECTPROP)/) &&
            ppprev.token.match(nameCharRE)
          ) {
            ppprev.type = T_FUNCTION;
          }
        }
      } else {
        tokens.push({ type: T_TEXT, token: char });
      }
      word = "";
    } else if (char.match(nameCharRE)) {
      word += char;
    }
    mergeTextTypes();
  }
  if (word != "") tokens.push(readWordToken(word));
  return tokens;

  function mergeTextTypes() {
    if (
      tokens.length > 1 &&
      tokens[tokens.length - 1].type == tokens[tokens.length - 2].type && tokens[tokens.length - 1].type != T_NEWLINE
    ) {
      tokens[tokens.length - 2].token += tokens[tokens.length - 1].token;
      tokens.pop();
    }
  }
  function readArgumentsToken(k) {
    // reads and finds arguments of a function being defined
    var args = text.substring(k + 1).match(/[^)]*/)[0];
    const index = args.length + 1;
    var argarr = [];
    var w = "";
    for (var l = 0; l < args.length; l++) {
      var ch = args[l]
      if (ch.match(nameCharRE)) {
        w += ch
      } else {
        if (ch.match(/[\t ]/)) {
          w += ch;
          continue
        } else {
          argarr.push({type: T_ARGUMENT, token: w});
          if (ch == "\n") argarr.push({type: T_NEWLINE});
          w = "";
        }
      }
    }
    if (text[k + index] == ")") argarr.push({ type: T_TEXT, token: ")" }); // adds right paren if it was there
    return [argarr, index + k];
  }

  // finds the type of word given
  function readWordToken(word) {
    try {
      tokens[tokens.length - 1]?.token[0] != "."
    } catch (error) {
      console.log(252, tokens[tokens.length-1])
    }
    if (word.match(KeywordRE)) {
      // Keyword
      return { type: T_KEY, token: word };
    } else if (word.match(number)) {
      // a number
      return { type: T_NUMBER, token: word };
    } else if (
        word.match(builtInObject) &&
        tokens[tokens.length - 2]?.token != "function" &&
        (tokens[tokens.length - 1]?.token || "")[0] != "."
    ) {
        // builtin objects word 
        //eg: Buffer, Array, String, ...
        return { type: T_CAPITAL, token: word };
    } else if (
      (tokens[tokens.length - 1]?.token || "").endsWith(".") ||
      (tokens[tokens.length - 2]?.token || "").endsWith(".")
    ) {
      return { type: T_OBJECTPROP, token: word };
    } else if (word.match(nullTypes)) {
      return { type: T_NULLTYPE, token: word };
    } else {
      return { type: T_TEXT, token: word };
    }
  }
}

function parse(tokens) {
  var formatted = "<span class='newline'>";
  for (var i = 0; i < tokens.length; i++) {
    var tkn = tokens[i],
      tokenType = tkn.type;
    if (tokenType.match(/(WS|TEXT|PAREN)/)) {
      formatted += tkn.token;
    } else if (tokenType == T_NEWLINE) {
      formatted += "</span><span class='newline'>";
    } else if (tokenType == T_OBJECTPROP) {
      formatted += "<span class='objprop'>" + tkn.token + "</span>";
    } else if (tokenType == T_KEY) {
      formatted += "<span class='keyword'>" + tkn.token + "</span>";
    } else if (tokenType == T_COMMENT) {
      formatted += "<span class='comment'>" + tkn.token + "</span>";
    } else if (tokenType == T_NUMBER) {
      formatted += "<span class='number'>" + tkn.token + "</span>";
    } else if (tokenType == T_FUNCTION) {
      formatted += "<span class='function'>" + tkn.token + "</span>";
    } else if (tokenType == T_ARGUMENT) {
      formatted += "<span class='argument'>" + tkn.token + "</span>";
    } else if (tokenType == T_CAPITAL) {
      formatted += "<span class='capital'>" + tkn.token + "</span>";
    } else if (tokenType == T_METHOD) {
      formatted += "<span class='method'>" + tkn.token + "</span>";
    } else if (tokenType == T_STRING) {
      formatted += "<span class='string'>" + tkn.token + "</span>";
    } else if (tokenType == T_REGEX) {
      formatted += "<span class='regex'>" + tkn.token + "</span>";
    } else if (tokenType == T_OPERATOR) {
      formatted += "<span class='operator'>" + tkn.token + "</span>";
    } else if (tokenType == T_NULLTYPE) {
      formatted += "<span class='nulltype'>" + tkn.token + "</span>";
    }
  }
  return formatted;
}