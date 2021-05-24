(function () {
  // useful stuffs

  // RegExes 
  var KeywordRE =
    /^(await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|NaN|native|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|with|yield)$/;
  var operatorRE = /[=+\-*/%!<>&|:?]*/;
  var nameCharRE = /[\wͰ-Ͽ\$]/;
  var number = /^(\d*(\.\d*)?|0x[0-9a-f]*|0b[01]*|\d+(\.\d*)?(e|E)\d*)$/;
  var commentRE = /((\/\*[\s\S]*?\*\/|\/\*[\s\S]*)|(\/\/.*))/;
  var stringRE = /('(((\\)+(')?)|([^']))*')|("(((\\)+(")?)|([^"]))*")/;
  var regexRE =
    /^\/((?![*+?])(?:[^\r\n\[/\\]|\\.|\[(?:[^\r\n\]\\]|\\.)*\])+)\/((?:g(?:im?|mi?)?|i(?:gm?|mg?)?|m(?:gi?|ig?)?)?)/;
  // builtIn objects
  var builtInObject =
    /^(AggregateError|Buffer|Array|ArrayBuffer|AsyncFunction|AsyncGenerator|AsyncGeneratorFunction|Atomics|BigInt|BigInt64Array|BigUint64Array|Boolean|DataView|Date|Error|EvalError|Float32Array|Float64Array|Function|Generator|GeneratorFunction|Int16Array|Int32Array|Int8Array|InternalError|Intl|JSON|Map|Math|Number|Object|Promise|Proxy|RangeError|ReferenceError|Reflect|RegExp|Set|SharedArrayBuffer|String|Symbol|SyntaxError|TypeError|URIError|Uint16Array|Uint32Array|Uint8Array|Uint8ClampedArray|WeakMap|WeakSet|WebAssembly)$/;

  // types of tokens
  const T_STRING = "STRING",
    T_KEY = "KEY",
    T_TEXT = "TEXT",
    T_OPERATOR = "OPERATOR",
    T_COMMENT = "COMMENT",
    T_NUMBER = "NUMBER",
    T_ARGUMENT = "ARGUMENT",
    T_CAPITAL = "CAPITAL",
    T_OBJECTPROP = "OBJECTPROP",
    T_METHOD = "METHOD",
    T_REGEX = "REGEX",
    T_LPAREN = "LPAREN",
    T_OTHER = "OTHER";
  // an empty token
  var emptyToken = { type: "", token: "" };

  // default configurations for output
  var config = {
    tabIndex: 4,
    fontSize: 16, // in px
    enableLineNumbering: true,
    lineHeight: 20,
  };

  // useful string patterns

  /**
   * Reverses the string
   * @returns reversed string
   */
  String.prototype.reverse = function () {
    return this.split("").reverse().join("");
  };

  /**
   * converts characters into html char codes
   * "<" -> "&lt;"
   * ">" -> "&gt;"
   * "&" -> "&amp;"
   * @returns string replacing some characters
   */
  String.prototype.replaceSpecHTMLChars = function () {
    return this.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  };

  window.onload = function () {
    var codes = document.getElementsByClassName("js-colorful");
    if (codes.length) {
      for (var k = 0; k < codes.length; k++) {
        var block = codes[k];
        var ln = block.getAttribute("lineNumbering");
        var lnBool = typeof ln == "string" ? true : false;
        var cfg = {
          tabIndex: block.getAttribute("tabindex") || config.tabIndex,
          fontSize: block.getAttribute("fontsize") || config.fontSize,
          lineHeight: block.getAttribute("lineheight") || config.lineHeight,
          enableLineNumbering: lnBool,
        };
        highlight(codes[k], cfg);
      }
    }
  };

  function highlight(container, cfg) {
    var w_h = 0.5498367766955267; // width/height of a monospace number
    var text = container.innerText;

    var d1 = window.performance.now();
    var out = tokenize(text);
    var markuped = parseToken(out.tokens, cfg.lineHeight);
    var compileTime = window.performance.now() - d1;
    var complete;
    var intentWidth = 0;
    if (cfg.enableLineNumbering) {
      var lineCount = text.match(/\n/g)?.length + 1 || 1;
      complete = "<table border=0><tr><td><pre class='colorful-numberRow'>";
      for (var i = 1; i <= lineCount; i++) {
        complete += i;
        if (i < lineCount) complete += "\n";
      }
      complete +=
        '</pre></td><td><pre class="colorful-code"><code id="colorful-output" tabindex=' +
        cfg.tabIndex +
        ">" +
        markuped +
        "</code></pre></td></tr></table>";
    } else {
      complete =
        '<pre class="colorful-code"><code id="colorful-output" tabindex=' +
        cfg.tabIndex +
        ">" +
        markuped +
        "</code></pre>";
    }
    container.style.fontSize = cfg.fontSize + "px";
    container.innerHTML = complete;
    var speed = ((text.length / 1024 / compileTime) * 1000).toFixed(3); //kb/s
    console.log(`total code analysed: ${(text.length / 1024).toFixed(3)} kb
found: ${out.tokens.length} tokens
compile time: ${compileTime.toFixed(4)} ms
compile speed: ${speed} kib/s`);
  }

  /**
   * tokenize input text
   *
   * @param {string} text
   * @param {Object} [ErrHandler={}]
   * @return {Array} tokens
   */
  function tokenize(text, ErrHandler = {}) {
    var len = text.length;
    var tokens = [],
      word = "",
      scopeTree = [],
      scope = "empty",
      braceUnMatchEnd = false;
    var i = 0;
    while (i < len) {
      word = text.substring(i).match(/^[\wͰ-Ͽ$]+/);
      var isNum, lastTkn;
      if (word) {
        var v = word[0];
        isNum = v.match(number);
        var c = isNum && text[i + v.length] == ".";
        lastTkn = tokens[tokens.length - 1] || {};
        var c2 = /[\.]$/.test(lastTkn.token) && isNum;
        if (c) {
          v += ".";
        }
        i += v.length;
        if (c2) {
          v = "." + v;
          if (lastTkn.token != ".")
            lastTkn.token = lastTkn.token.substr(0, lastTkn.token.length - 1);
          else tokens.pop();
        }
        readWordToken(v);
        if (c) continue;
        mergeSameTypes();
      }
      if (i == len) break;
      lastTkn = tokens[tokens.length - 1] || emptyToken;
      /*
      after matching a word there will be a non alphanumeric(and non '$') code
      there will be something else the following code analyses that
      */
      var char = text[i]; // next character
      var next2 = text.substr(i, 2); // next two characters

      if (/\s/.test(char)) {
        // next character is a space/tab/line break
        var space = text.substring(i).match(/[\s]+/)[0];
        if (lastTkn.token) lastTkn.token += space;
        else addToken(T_TEXT, space)
        i += space.length;
      } else if (next2 == "//" || next2 == "/*") {
        // comment ahead
        var comment = text.substring(i, len).match(commentRE)[0];
        i += comment.length;
        addToken(T_COMMENT, comment.replaceSpecHTMLChars());
      } else if (char == "'" || char == '"') {
        // string ahead
        var str = text.substring(i, len).match(stringRE)[0];
        i += str.length;
        addToken(T_STRING, str);
      } else if (char == "`") {
        // multiline string ahead

        addToken(T_STRING, "`");
        i++;
        var str = "";
        while (i < len) {
          var ch = text[i];
          if (ch != "`") {
            if (text.substr(i, 2) == "${") {
              addToken(T_STRING, str);
              str = "";
              addToken(T_OPERATOR, "${");
              i += 2;
              var out = tokenize(text.substring(i), { braceUnMatch: "break" });
              if (out.tokens.length) tokens = tokens.concat(out.tokens);
              if (out.braceUnmatchEnd) {
                addToken(T_OPERATOR, "}");
                i++;
              }
              i += out.inputEnd;
            } else {
              str += ch;
              i++;
            }
          } else if (text[i - 1] == "\\") {
            if (text[i - 2] != "//") {
              str += ch;
              i++;
            } else {
              addToken(T_STRING, str);
              break;
            }
          } else {
            str += ch;
            i++;
            break;
          }
        }
        if (str != "") addToken(T_STRING, str);
      } else if (char.match(operatorRE)[0]) {
        // math operators
        if (char == "/" && !/[\wͰ-Ͽ$]/.test(text[i - 1])) {
          // search for regular expressions
          var re = text.substring(i, len).match(regexRE);
          if (re) {
            // regular expression ahead
            addToken(T_REGEX, re[0]);
            i += re[0].length;
          }
        }
        var operators = text.substring(i).match(operatorRE)[0];
        if (operators == "=>") {
          if (lastTkn.type == "TEXT") {
            lastTkn.type = "ARGUMENT";
          } else if (/\)\s*$/.test(lastTkn.token)) {
            var initialScopeLevel = scopeTree.length;
            var argsarr = [tokens[tokens.length-1]];
            for (var k = tokens.length - 2; k >= 0; k--) {
              var tk = tokens[k];
              argsarr.push(tk);
              if (tk.type == T_OTHER && tk.scopeLevel == initialScopeLevel) {
                tokens.splice(k);
                break
              }
            }
            argsarr.reverse();
            readArgumentsInTokens(argsarr, initialScopeLevel+1, false);
          }
        }
        // finds next group of operators
        i += operators.length;
        addToken(T_OPERATOR, operators.replaceSpecHTMLChars());
      } else if (char == "(") {
        // function name
        var tl = tokens.length;
        var prev = lastTkn;
        var prevt = prev.token || "";
        var pprev = tokens[tl - 2] || emptyToken;
        var ppprev = tokens[tl - 3] || emptyToken;
        addToken(T_OTHER, "(");
        i++;
        scopeTree.push("brace");
        const isFunctionClause =
          prevt.substr(0, 8) == "function" ||
          pprev.token.substr(0, 8) == "function" ||
          scopeTree[scopeTree.length - 1] == "class";
        var prevtIsCh = nameCharRE.test(prevt);
        var pprevtIsCh = nameCharRE.test(pprev.token);
        if (isFunctionClause) {
          // function defnition ahead
          // makes name of function colored to method
          if (prev.type == T_TEXT && prevtIsCh) {
            prev.type = T_METHOD;
          } else if (pprev.type == T_TEXT && pprevtIsCh) {
            pprev.type = T_METHOD;
          }

          // reads arguments
          if (next2 != "()") {
            var tkn = tokenize(text.substring(i), { parenUnMatch: "break" });
            var tkns = tkn.tokens;
            readArgumentsInTokens(tkns);
            i += tkn.inputEnd;
          }
        } else if (
          prevtIsCh &&
          /[\wͰ-Ͽ$\s]+/.test(
            (prevt.reverse().match(/^(\s)*[\wͰ-Ͽ$\s]+/) || [""])[0]
          )
        ) {
          //this is function calling clause
          if ((prev.type == "TEXT" || prev.type == "OBJECTPROP") && prevtIsCh) {
            prev.type = T_METHOD;
          } else if (
            (pprev.type == "TEXT" || pprev.type == "OBJECTPROP") &&
            pprevtIsCh
          ) {
            pprev.type = T_METHOD;
          } else if (
            (ppprev.type == "TEXT" || ppprev.type == "OBJECTPROP") &&
            nameCharRE.test(ppprev.token)
          ) {
            ppprev.type = T_METHOD;
          }
        }
      } else if (char == ")") {
        if (scopeTree.length > 0) {
          scopeTree.pop();
        } else if (ErrHandler.parenUnMatch == "break") {
          parenUnMatchEnd = true;
          break;
        }
        addToken("OTHER", char);
        i++;
      } else if (char == "{") {
        addToken("OTHER", char);
        i++;
        scopeTree.push(scope);
        scope = "empty";
      } else if (char == "}") {
        if (scopeTree.length > 0) {
          scopeTree.pop();
        } else if (ErrHandler.braceUnMatch == "break") {
          braceUnMatchEnd = true;
          break;
        }
        addToken("OTHER", char);
        i++;
      } else if (char == "[") {
        addToken("OTHER", char);
        i++;
        scopeTree.push(scope);
        scope = "empty";
      } else if (char == "]") {
        if (scopeTree.length > 0) {
          scopeTree.pop();
        } else if (ErrHandler.bracketUnMatch == "break") {
          bracketUnMatch = true;
          break;
        }
        addToken("OTHER", char);
        i++;
      } else {
        addToken("OTHER", char);
        i++;
      }
      mergeSameTypes();
    }
    return { tokens: tokens, inputEnd: i, braceUnmatchEnd: braceUnMatchEnd };
    function addToken(type, token) {
      tokens.push({ type: type, token: token, scopeLevel: scopeTree.length });
    }

    /*
    merges same type of consecutive tokens into
    single one to minimize tokens to parse
    */
    function mergeSameTypes() {
      var tl = tokens.length;
      if (
        tokens[tl - 1].type == tokens[tl - 2]?.type &&
        tokens[tl - 1].scopeLevel == tokens[tl - 2]?.scopeLevel
      ) {
        tokens[tl - 2].token += tokens[tl - 1].token;
        tokens.pop();
      }
    }

    // read arguments
    function readArgumentsInTokens(tks, base=0, increase=true) {
      for (var k = 0; k < tks.length; k++) {
        var tk = tks[k];
        if (
          tk.type == T_TEXT &&
          tk.scopeLevel == base &&
          tks[k - 1]?.type != T_OPERATOR
        ) {
          tk.type = T_ARGUMENT;
        }
        if (increase) tk.scopeLevel++;
      }
      tokens = tokens.concat(tks);
    }

    // finds the type of word given
    function readWordToken(word) {
      var pprevt = tokens[tokens.length - 2]?.token || "";
      var prevt = lastTkn.token || "";
      if (
        KeywordRE.test(word) || // global keywords
        (word == "arguments" &&
          scopeTree[scopeTree.length - 1] == "function") || // argument inside function clause
        ((word == "get" || word == "set") &&
          scopeTree[scopeTree.length - 1] == "class") // get/set inside class scope
      ) {
        // Keyword
        if (
          /(function|if|do|while|for|class|catch|else|finally|switch|try)/.test(
            word
          )
        ) {
          scope = word;
        }
        addToken(T_KEY, word);
      } else if (number.test(word)) {
        addToken(T_NUMBER, word);
      } else if (
        builtInObject.test(word) &&
        pprevt != "function" &&
        prevt[0] != "."
      ) {
        // builtin objects word
        addToken(T_CAPITAL, word);
      } else if (prevt.endsWith(".") || pprevt.endsWith(".")) {
        // object property
        addToken(T_OBJECTPROP, word);
      } else {
        addToken(T_TEXT, word);
      }
    }
  }

  function parseToken(tokens) {
    var formatted = ``;
    var d = {
        TEXT: "name",
        OBJECTPROP: "objprop",
        KEY: "keyword",
        COMMENT: "comment",
        NUMBER: "number",
        ARGUMENT: "argument",
        CAPITAL: "capital",
        METHOD: "method",
        STRING: "string",
        REGEX: "regex",
        OPERATOR: "operator",
      };
    for (var i = 0; i < tokens.length; i++) {
      var tkn = tokens[i],
        tokenType = tkn.type;
      if (tokenType != "OTHER") {
        formatted +=
          "<span class='js-" + d[tokenType] + "'>" + tkn.token + "</span>";
      } else {
        formatted += tkn.token;
      }
    }
    return formatted;
  }
})();