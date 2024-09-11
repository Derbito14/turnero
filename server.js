const express = require('express');
const { Pool } = require('pg'); // Reemplazamos mysql2 por pg
const session = require('express-session');
const path = require('path');
const moment = require('moment');
require('moment/locale/es'); // Cargar localización en español

const app = express();
const port = process.env.PORT || 3000;

// Configuración de la base de datos PostgreSQL
    const pool = new Pool({
        host: 'localhost',
        user: 'postgres', // Cambia según tu configuración
        password: 'derby123',
        database: 'turnosdb',
        port: 5432, // Puerto por defecto para PostgreSQL
    });

// Conectar a la base de datos
pool.connect(err => {
    if (err) throw err;
    console.log('Conectado a la base de datos PostgreSQL.');
});

// Configuración de Express
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuración para servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'secreto',
    resave: false,
    saveUninitialized: true
}));

// Configuración de EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Función para capitalizar el primer carácter de una cadena
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

// Página de login
app.get('/', (req, res) => {
    res.render('login', { error: null });
});

// Ruta de login
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    const query = 'SELECT * FROM usuario WHERE username = $1';
    pool.query(query, [username], (err, result) => {
        if (err) throw err;

        if (result.rows.length > 0) {
            const user = result.rows[0];

            // Comparar contraseñas en texto plano
            if (password === user.password) {
                req.session.userId = user.id;
                req.session.username = user.username; // Guardar nombre de usuario en la sesión
                res.redirect('/turnos');
            } else {
                res.render('login', { error: 'Usuario o contraseña incorrectos.' });
            }
        } else {
            res.render('login', { error: 'Usuario o contraseña incorrectos.' });
        }
    });
});

// Ruta de turnos (solo accesible si el usuario está logueado)
app.get('/turnos', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/');
    }

    // Verificar si el usuario es 'tradelog'
    const isTradeLog = req.session.username === 'tradelog';

    // Generar el listado de días
    let startDate, endDate;

    if (isTradeLog) {
        // Para 'tradelog'
        startDate = moment().subtract(2, 'days').startOf('day');
        endDate = moment(startDate).add(7, 'days');
    } else {
        // Para otros usuarios
        startDate = moment().add(1, 'days').startOf('day');
        endDate = moment(startDate).add(7, 'days');
    }

    let days = [];
    for (let date = startDate; date.isBefore(endDate); date.add(1, 'days')) {
        let dayType;
        const dayOfWeek = date.day(); // 0 = domingo, 1 = lunes, ..., 6 = sábado

        if (dayOfWeek === 0) {
            dayType = 'sunday';
        } else if (dayOfWeek === 6) {
            dayType = 'saturday';
        } else {
            dayType = 'weekday';
        }

        days.push({
            dayName: capitalizeFirstLetter(date.format('dddd')),
            date: date.format('DD/MM/YYYY'),
            dayType: dayType
        });
    }

    // Obtener las reservas para los días
    const queries = days.map(day => {
        const formattedDay = moment(day.date, 'DD/MM/YYYY').format('YYYY-MM-DD');
        return new Promise((resolve, reject) => {
            pool.query('SELECT * FROM reservas WHERE day = $1', [formattedDay], (err, result) => {
                if (err) return reject(err);
                resolve(result.rows);
            });
        });
    });

    Promise.all(queries)
        .then(results => {
            const reservations = results.map(res => res.reduce((acc, cur) => {
                acc[cur.hour] = cur;
                return acc;
            }, {}));
            res.render('turnos', { days: days, username: req.session.username, isTradeLog: isTradeLog, reservations: reservations });
        })
        .catch(err => {
            console.error('Error al obtener reservas:', err);
            res.status(500).send('Error al obtener reservas.');
        });
});

// Ruta para realizar la reserva
app.post('/reservar', (req, res) => {
    const { day, hour, pallets, domain } = req.body;
    const username = req.session.username; // Obtener el nombre de usuario desde la sesión

    if (!req.session.userId) {
        return res.status(401).send('Usuario no autenticado.');
    }

    // Validar los datos recibidos
    if (!day || !hour || !pallets || !domain) {
        return res.status(400).send('Datos incompletos.');
    }

    // Convertir la fecha a formato PostgreSQL (yyyy-mm-dd)
    const formattedDay = moment(day, 'DD/MM/YYYY').format('YYYY-MM-DD');

    // Insertar la reserva en la base de datos
    const query = `
        INSERT INTO reservas (user_name, day, hour, pallets, domain, completed)
        VALUES ($1, $2, $3, $4, $5, $6)
    `;

    pool.query(query, [username, formattedDay, hour, pallets, domain, 0], (err, result) => {
        if (err) {
            console.error('Error al insertar la reserva:', err);
            return res.status(500).send('Error al realizar la reserva.');
        }

        // Reserva realizada con éxito
        res.status(200).send('Reserva realizada con éxito.');
    });
});

// Ruta para obtener reservas para un día específico
app.get('/reservas', (req, res) => {
    const { date } = req.query;

    if (!date) {
        return res.status(400).send('Fecha requerida.');
    }

    const formattedDate = moment(date, 'DD/MM/YYYY').format('YYYY-MM-DD');

    const query = 'SELECT * FROM reservas WHERE day = $1';
    pool.query(query, [formattedDate], (err, result) => {
        if (err) {
            console.error('Error al obtener las reservas:', err);
            return res.status(500).send('Error al obtener reservas.');
        }

        res.json(result.rows);
    });
});

// Ruta para eliminar una reserva
app.post('/eliminar-reserva', (req, res) => {
    const { day, hour } = req.body;
    const username = req.session.username;

    if (!req.session.userId) {
        return res.status(401).send('Usuario no autenticado.');
    }

    // Validar los datos recibidos
    if (!day || !hour) {
        return res.status(400).send('Datos incompletos.');
    }

    // Convertir la fecha a formato PostgreSQL (yyyy-mm-dd)
    const formattedDay = moment(day, 'DD/MM/YYYY').format('YYYY-MM-DD');

    // Eliminar la reserva de la base de datos
    const query = `
        DELETE FROM reservas
        WHERE day = $1 AND hour = $2 AND (user_name = $3 OR $3 = 'tradelog')
    `;

    pool.query(query, [formattedDay, hour, username], (err, result) => {
        if (err) {
            console.error('Error al eliminar la reserva:', err);
            return res.status(500).send('Error al eliminar la reserva.');
        }

        // Reserva eliminada con éxito
        res.status(200).send('Reserva eliminada con éxito.');
    });
});

// Ruta de logout
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect('/turnos');
        res.redirect('/');
    });
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});
