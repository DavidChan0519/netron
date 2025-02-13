/* jshint esversion: 6 */
/* eslint "indent": [ "error", 4, { "SwitchCase": 1 } ] */

var ncnn = ncnn || {};

// https://github.com/Tencent/ncnn/wiki/param-and-model-file-structure
// https://github.com/Tencent/ncnn/wiki/operation-param-weight-table

ncnn.ModelFactory = class {

    match(context) {
        var identifier = context.identifier.toLowerCase();
        if (identifier.endsWith('param') || identifier.endsWith('.cfg.ncnn')) {
            var text = context.text;
            text = text.substring(0, Math.min(text.length, 32));
            var signature = text.split('\n').shift().trim();
            if (signature === '7767517') {
                return true;
            }
        }
        return false;
    }

    open(context, host) {
        return ncnn.Metadata.open(host).then((metadata) => {
            var identifier = context.identifier.toLowerCase();
            var param = (bin) => {
                try {
                    return new ncnn.Model(metadata, context.text, bin);
                }
                catch (error) {
                    var message = error && error.message ? error.message : error.toString();
                    message = message.endsWith('.') ? message.substring(0, message.length - 1) : message;
                    throw new ncnn.Error(message + " in '" + identifier + "'.");
                }
            };
            if (identifier.endsWith('param') || identifier.endsWith('.cfg.ncnn')) {
                var bin = null;
                if (identifier.endsWith('param')) {
                    bin = context.identifier.substring(0, context.identifier.length - 6) + '.bin';
                }
                else if (identifier.endsWith('.cfg.ncnn')) {
                    bin = context.identifier.substring(0, context.identifier.length - 9) + '.weights.ncnn';
                }
                return context.request(bin, null).then((bin) => {
                    return param(bin);
                }).catch(() => {
                    return param(null);
                });
            }
            else {
                throw new ncnn.Error('Not implemented.');
            }
        });
    }
}

ncnn.Model = class {

    constructor(metadata, param, bin) {
        this._format = 'NCNN'
        this._graphs = [];
        this._graphs.push(new ncnn.Graph(metadata, param, bin));
    }

    get format() {
        return this._format;
    }

    get graphs() {
        return this._graphs;
    }
}

ncnn.Graph = class {

    constructor(metadata, param, bin) {
        this._inputs = [];
        this._outputs = [];
        this._nodes = [];

        var reader = new ncnn.BlobReader(bin);

        var lines = param.split('\n');
        var signature = lines.shift();
        if (signature !== '7767517') {
            throw new ncnn.Error('Invalid signature.')
        }
        var header = lines.shift().split(' ');
        if (header.length !== 2) {
            throw new ncnn.Error('Invalid header count.');
        }

        var layers = [];
        var layer;
        while (lines.length > 0) {
            var line = lines.shift().trim();
            if (line.length > 0) {
                var columns = line.split(' ').filter((s) => s.length != 0);
                layer = {};
                layer.type = columns.shift();
                layer.name = columns.shift();
                var inputCount = parseInt(columns.shift(), 10);
                var outputCount = parseInt(columns.shift(), 10);
                layer.inputs = columns.splice(0, inputCount);
                layer.outputs = columns.splice(0, outputCount);
                layer.attr = {};
                layer.attributes = columns.map((attribute) => {
                    var list = attribute.split('=');
                    var key = list[0].trim();
                    var value = list[1].trim();
                    var keyInt = parseInt(key, 10);
                    if (key < 0) {
                        value = value.split(',').map((v) => v.trim());
                        value.shift();
                        key = (-(keyInt + 23300)).toString();
                    }
                    layer.attr[key] = value;
                    return { key: key, value: value };
                });
                layers.push(layer);
            }
        }

        for (layer of layers) {
            if (layer.type == 'Input') {
                var dimensions = layer.attributes.map((a) => parseInt(a.value, 10));
                var shape = new ncnn.TensorShape(dimensions);
                var type = new ncnn.TensorType('float32', shape);
                this._inputs.push(new ncnn.Parameter(layer.name, true, layer.outputs.map((output) => new ncnn.Argument(output, type, null))));
            }
            else {
                this._nodes.push(new ncnn.Node(metadata, reader, layer));
            }
        }
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }
}

ncnn.Parameter = class {

    constructor(name, visible, args) {
        this._name = name;
        this._visible = visible;
        this._arguments = args;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return this._visible;
    }

    get arguments() {
        return this._arguments;
    }
};

ncnn.Argument = class {
    constructor(id, type, initializer) {
        this._id = id;
        this._type = type || null;
        this._initializer = initializer || null;
    }

    get id() {
        return this._id;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
};

ncnn.Node = class {

    constructor(metadata, reader, layer) {
        this._metadata = metadata;
        this._inputs = [];
        this._outputs = [];
        this._attributes = [];
        this._operator = layer.type;
        this._name = layer.name;

        var schema = metadata.getSchema(this._operator);

        var attributeMetadata = {};
        if (schema && schema.attributes) {
            for (var i = 0; i < schema.attributes.length; i++) {
                var id = schema.attributes[i].id || i.toString();
                attributeMetadata[id] = schema.attributes[i];
            }
        }
        for (var attribute of layer.attributes) {
            var attributeSchema = attributeMetadata[attribute.key];
            this._attributes.push(new ncnn.Attribute(attributeSchema, attribute.key, attribute.value));
        }

        var inputs = layer.inputs;
        var inputIndex = 0;
        if (schema && schema.inputs) {
            for (var inputDef of schema.inputs) {
                if (inputIndex < inputs.length || inputDef.option != 'optional') {
                    var inputCount = (inputDef.option == 'variadic') ? (inputs.length - inputIndex) : 1;
                    var inputArguments = inputs.slice(inputIndex, inputIndex + inputCount).filter((id) => id != '' || inputDef.option != 'optional').map((id) => {
                        return new ncnn.Argument(id, null, null);
                    });
                    this._inputs.push(new ncnn.Parameter(inputDef.name, true, inputArguments));
                    inputIndex += inputCount;
                }
            }
        }
        else {
            this._inputs = this._inputs.concat(inputs.slice(inputIndex).map((input, index) => {
                var inputName = ((inputIndex + index) == 0) ? 'input' : (inputIndex + index).toString();
                return new ncnn.Parameter(inputName, true, [
                    new ncnn.Argument(input, null, null)
                ]);
            }));
        }

        var outputs = layer.outputs;
        var outputIndex = 0;
        if (schema && schema.outputs) {
            for (var outputDef of schema.outputs) {
                if (outputIndex < outputs.length || outputDef.option != 'optional') {
                    var outputCount = (outputDef.option == 'variadic') ? (outputs.length - outputIndex) : 1;
                    var outputArguments = outputs.slice(outputIndex, outputIndex + outputCount).map((id) => {
                        return new ncnn.Argument(id, null, null)
                    });
                    this._outputs.push(new ncnn.Parameter(outputDef.name, true, outputArguments));
                    outputIndex += outputCount;
                }
            }
        }
        else {
            this._outputs = this._outputs.concat(outputs.slice(outputIndex).map((output, index) => {
                var outputName = ((outputIndex + index) == 0) ? 'output' : (outputIndex + index).toString();
                return new ncnn.Parameter(outputName, true, [
                    new ncnn.Argument(output, null, null)
                ]);
            }));
        }

        var num_output;
        var weight_data_size;
        var channels;
        var scale_data_size;
        var bias_data_size;
        switch (this._operator) {
            case 'BatchNorm':
                channels = parseInt(layer.attr['0'] || 0, 10);
                this._weight(reader, 'slope', [ channels ], 'float32');
                this._weight(reader, 'mean', [ channels ], 'float32');
                this._weight(reader, 'variance', [ channels ], 'float32');
                this._weight(reader, 'bias', [ channels ], 'float32');
                reader.next();
                break;
            case 'InnerProduct':
                num_output = parseInt(layer.attr['0'] || 0, 10);
                weight_data_size = parseInt(layer.attr['2'] || 0, 10);
                this._weight(reader, 'weight', [ num_output, weight_data_size / num_output ]);
                if (layer.attr['1'] == '1') {
                    this._weight(reader, 'bias', [ num_output ], 'float32');
                }
                reader.next();
                break;
            case 'Bias':
                bias_data_size = parseInt(layer.attr['0'] || 0, 10);
                this._weight(reader, 'bias', [ bias_data_size ], 'float32');
                reader.next();
                break;
            case 'Embed':
                this._weight('weight');
                this._weight('bias');
                reader.next();
                break;
            case 'Convolution':
            case 'ConvolutionDepthWise':
            case 'Deconvolution':
            case 'DeconvolutionDepthWise':
                num_output = parseInt(layer.attr['0'] || 0, 10);
                var kernel_w = parseInt(layer.attr['1'] || 0, 10);
                var kernel_h = parseInt(layer.attr['1'] || kernel_w, 10);
                weight_data_size = parseInt(layer.attr['6'] || 0, 10);
                this._weight(reader, 'weight', [ num_output, weight_data_size / ( num_output * kernel_w * kernel_h), kernel_w, kernel_h ]);
                if (layer.attr['5'] == '1') {
                    this._weight(reader, 'bias', [ num_output ], 'float32');
                }
                reader.next();
                break;
            case 'Dequantize':
                if (layer.attr['1'] == '1') {
                    bias_data_size = parseInt(layer.attr['2'] || 0, 10);
                    this._weight(reader, 'bias', [ bias_data_size ], 'float32');
                }
                reader.next();
                break;
            case 'Requantize':
                if (layer.attr['2'] == '1') {
                    bias_data_size = parseInt(layer.attr['3'] || 0, 10);
                    this._weight(reader, 'bias', [ bias_data_size ], 'float32');
                }
                reader.next();
                break;
            case 'InstanceNorm':
                channels = parseInt(layer.attr['0'] || 0, 10);
                this._weight(reader, 'gamma', [ channels ], 'float32');
                this._weight(reader, 'beta', [ channels ], 'float32');
                reader.next();
                break;
            case 'Scale':
                scale_data_size = parseInt(layer.attr['0'] || 0, 10);
                if (scale_data_size != -233) {
                    this._weight(reader, 'scale', [ scale_data_size], 'float32');
                    if (layer.attr['1'] == '1') {
                        this._weight(reader, 'bias', [ scale_data_size ], 'float32');
                    }
                    reader.next();
                }
                break;
            case 'Normalize':
                scale_data_size = parseInt(layer.attr['3'] || 0, 10);
                this._weight(reader, 'scale', [ scale_data_size ], 'float32');
                reader.next();
                break;
            case 'PReLU':
                var num_slope = parseInt(layer.attr['0'] || 0, 10);
                this._weight(reader, 'slope', [ num_slope ], 'float32');
                reader.next();
                break;
        }
    }

    get operator() {
        return this._operator;
    }

    get name() {
        return this._name;
    }

    get category() {
        var schema = this._metadata.getSchema(this._operator);
        return (schema && schema.category) ? schema.category : '';
    }

    get documentation() {
        return '';
    }

    get attributes() {
        return this._attributes;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    _weight(reader, name, dimensions, dataType) {
        dimensions = dimensions || null;
        var data = null;
        if (dimensions) {
            var size = 1;
            for (var dimension of dimensions) {
                size *= dimension;
            }
            if (!dataType) {
                dataType = reader.dataType;
            }
            data = reader.read(size, dataType);
        }
        else {
            dataType = dataType || '?';
            reader.dispose();
        }
        this._inputs.push(new ncnn.Parameter(name, true, [
            new ncnn.Argument('', null, new ncnn.Tensor(new ncnn.TensorType(dataType, new ncnn.TensorShape(dimensions)), data))
        ]));
    }
}

ncnn.Attribute = class {

    constructor(schema, key, value) {
        this._type = '';
        this._name = key;
        this._value = value;
        if (schema) {
            this._name = schema.name;
            if (schema.type) {
                this._type = schema.type;
            }
            switch (this._type) {
                case 'int32':
                    this._value = parseInt(this._value, 10);
                    break;
                case 'float32':
                    this._value = parseFloat(this._value);
                    break;
            }
            if (Object.prototype.hasOwnProperty.call(schema, 'visible') && !schema.visible) {
                this._visible = false;
            }
            else if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
                if (this._value == schema.default || (this._value && this._value.toString() == schema.default.toString())) {
                    this._visible = false;
                }
            }
        }
    }

    get type() {
        return this._type;
    }

    get name() {
        return this._name;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible == false ? false : true;
    }
}

ncnn.Tensor = class {

    constructor(type, data) {
        this._type = type;
        this._data = data;
    }

    get kind() {
        return 'Weight';
    }

    get type() {
        return this._type;
    }

    get state() {
        return this._context().state || null;
    }

    get value() {
        var context = this._context();
        if (context.state) {
            return null;
        }
        context.limit = Number.MAX_SAFE_INTEGER;
        return this._decode(context, 0);
    }

    toString() {
        var context = this._context();
        if (context.state) {
            return '';
        }
        context.limit = 10000;
        var value = this._decode(context, 0);
        return JSON.stringify(value, null, 4);
    }

    _context() {
        var context = {};
        context.index = 0;
        context.count = 0;
        context.state = null;

        if (this._type.dataType == '?') {
            context.state = 'Tensor has unknown data type.';
            return context;
        }
        if (!this._type.shape) {
            context.state = 'Tensor has no dimensions.';
            return context;
        }

        if (!this._data) {
            context.state = 'Tensor data is empty.';
            return context;
        }

        switch (this._type.dataType) {
            case 'float32':
                context.data = new DataView(this._data.buffer, this._data.byteOffset, this._data.byteLength);
                break;
            default:
                context.state = 'Tensor data type is not implemented.';
                break;
        }

        context.dataType = this._type.dataType;
        context.shape = this._type.shape.dimensions;
        return context;
    }

    _decode(context, dimension) {
        var shape = context.shape;
        if (context.shape.length == 0) {
            shape = [ 1 ];
        }
        var results = [];
        var size = shape[dimension];
        if (dimension == shape.length - 1) {
            for (var i = 0; i < size; i++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                switch (this._type.dataType)
                {
                    case 'float32':
                        results.push(context.data.getFloat32(context.index, true));
                        context.index += 4;
                        context.count++;
                        break;
                }
            }
        }
        else {
            for (var j = 0; j < size; j++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                results.push(this._decode(context, dimension + 1));
            }
        }
        if (context.shape.length == 0) {
            return results[0];
        }
        return results;
    }

}

ncnn.TensorType = class {

    constructor(dataType, shape) {
        this._dataType = dataType || '?';
        this._shape = shape;
    }

    get dataType() {
        return this._dataType;
    }

    get shape()
    {
        return this._shape;
    }

    toString() {
        return this._dataType + this._shape.toString();
    }
}

ncnn.TensorShape = class {

    constructor(dimensions) {
        this._dimensions = dimensions;
    }

    get dimensions() {
        return this._dimensions;
    }

    toString() {
        return this._dimensions ? ('[' + this._dimensions.map((dimension) => dimension ? dimension.toString() : '?').join(',') + ']') : '';
    }
};

ncnn.Metadata = class {

    static open(host) {
        if (ncnn.Metadata._metadata) {
            return Promise.resolve(ncnn.Metadata._metadata);
        }
        return host.request(null, 'ncnn-metadata.json', 'utf-8').then((data) => {
            ncnn.Metadata._metadata = new ncnn.Metadata(data);
            return ncnn.Metadata._metadata;
        }).catch(() => {
            ncnn.Metadata._metadata = new ncnn.Metadata(null);
            return ncnn.Metadata._metadatas;
        });
    }

    constructor(data) {
        this._map = {};
        this._attributeCache = {};
        if (data) {
            var items = JSON.parse(data);
            if (items) {
                for (var item of items) {
                    if (item.name && item.schema) {
                        this._map[item.name] = item.schema;
                    }
                }
            }
        }
    }

    getSchema(operator) {
        return this._map[operator] || null;
    }

    getAttributeSchema(operator, name) {
        var map = this._attributeCache[operator];
        if (!map) {
            map = {};
            var schema = this.getSchema(operator);
            if (schema && schema.attributes && schema.attributes.length > 0) {
                for (var attribute of schema.attributes) {
                    map[attribute.name] = attribute;
                }
            }
            this._attributeCache[operator] = map;
        }
        return map[name] || null;
    }
};

ncnn.BlobReader = class {

    constructor(buffer) {
        this._buffer = buffer;
        this._position = 0;
    }

    get dataType() {
        if (!this._dataType && this._buffer && this._position + 4 < this._buffer.length) {
            var f0 = this._buffer[this._position++];
            var f1 = this._buffer[this._position++];
            var f2 = this._buffer[this._position++];
            var f3 = this._buffer[this._position++];
            var flag = f0 + f1 + f2 + f3;
            var value = f0 | f1 << 8 | f2 << 16 | f3 << 24;
            switch (value) {
                case 0x00000000:
                    this._dataType = 'float32';
                    break;
                case 0x01306B47:
                    // float16
                    debugger;
                    break;
                case 0x000D4B38:
                    // int8
                    debugger;
                    break;
                case 0x0002C056:
                    // size * sizeof(float) - raw data with extra scaling
                    debugger;
                    break;
                default:
                    if (flag != 0) {
                        this._dataType = 'qint8';
                    }
                    else {
                        debugger;
                    }
                    break;
            }
        }
        return this._dataType || '?';
    }

    read(size, dataType) {
        if (this._buffer) {
            dataType = dataType || this.dataType;
            switch (dataType) {
                case 'float32': 
                    var position = this._position
                    size *= 4;
                    this._position += size;
                    return this._buffer.subarray(position, this._position);
                case 'qint8':
                    this._position += size + 1024;
                    return null;
                default:
                    this.dispose();
                    break;
            }
        }
        return null;
    }

    next() {
        this._dataType = null;
    }

    dispose() {
        this._dataType = null;
        this._buffer = null;
    }
}

ncnn.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading ncnn model.';
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = ncnn.ModelFactory;
}